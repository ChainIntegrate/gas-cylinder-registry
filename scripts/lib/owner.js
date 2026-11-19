"use strict";
// The owner tools' logic, without any user interface: the command line (scripts/owner.js) and the
// tests call these functions. Every write is an owner-signed operation handed to `submit`, which sends
// it through the relayer or, until the relayer exists, from a funded submitter key.

const { Contract, ContractFactory, getAddress, hexlify, randomBytes, id, keccak256, ZeroHash, toUtf8String } = require("ethers");
const S = require("../../shared");
// Version 2 of the contracts (DESIGN.md 10.1). Version 1 (the demo) is only deployed, never used here.
const REGISTRY_ABI = require("../../shared/abi/GasCylinderRegistryV2.json");
const FACTORY_ABI = require("../../shared/abi/GasCylinderRegistryFactoryV2.json");
const FACTORY_V1_ABI = require("../../shared/abi/GasCylinderRegistryFactory.json");

const OWNER_VALIDITY_SECONDS = 3600;

// ------------------------------------------------------------------------------------------------
// Submitting signed operations
// ------------------------------------------------------------------------------------------------

/**
 * A submitter that sends signed operations itself, paying the gas from `wallet` (ChainIntegrate's
 * key during the demo, until the relayer exists). Returns the receipt.
 */
function directSubmitter(wallet) {
  return async (registryAddress, method, args) => {
    const reg = new Contract(registryAddress, REGISTRY_ABI, wallet);
    const tx = await reg[method](...args);
    return tx.wait();
  };
}

/**
 * A submitter that hands signed operations to the relayer (`url`, for example
 * https://crosschain-lukso.chainintegrate.it) and waits for the receipt on `provider`.
 */
function relayerSubmitter(url, provider) {
  const base = url.replace(/\/+$/, "");
  return async (registryAddress, method, args) => {
    const res = await fetch(`${base}/gcr/owner`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ registry: registryAddress, method, args }, (k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`relayer: ${body.error || res.status}`);
    for (let i = 0; i < 300; i++) {
      const receipt = await provider.getTransactionReceipt(body.hash);
      if (receipt) {
        if (receipt.status !== 1) throw new Error(`transaction ${body.hash} failed`);
        return receipt;
      }
      await new Promise((r) => setTimeout(r, i < 20 ? 100 : 2000));
    }
    throw new Error(`transaction ${body.hash} not confirmed yet: check it on the explorer`);
  };
}

// ------------------------------------------------------------------------------------------------
// Context
// ------------------------------------------------------------------------------------------------

/**
 * Everything a command needs about one registry.
 * @param {object} o
 * @param o.provider     an ethers provider
 * @param o.registry     the registry's address
 * @param o.owner        the owner's signer (an ethers Wallet), when the command writes
 * @param o.submit       a submitter (see directSubmitter), when the command writes
 * @param o.fromBlock    the registry's creation block, where log scans start
 */
async function context({ provider, registry, owner, submit, fromBlock = 0 }) {
  const address = getAddress(registry);
  const { chainId } = await provider.getNetwork();
  return {
    provider,
    address,
    chainId,
    registry: new Contract(address, REGISTRY_ABI, provider),
    owner,
    submit,
    fromBlock,
    domain: S.domain(address, chainId),
  };
}

/** A validity for an owner signature: from the chain's clock, for an hour. */
async function ownerValidity(ctx) {
  const block = await ctx.provider.getBlock("latest");
  return S.validity(block.timestamp, OWNER_VALIDITY_SECONDS);
}

/**
 * Signs `type` with the owner's signer: returns [validity, signature]. `extra` travels to the
 * ChainIntegrate Account extension with the request (a plain ethers key ignores it).
 */
async function signAsOwner(ctx, type, message, extra) {
  const v = await ownerValidity(ctx);
  const signature = await ctx.owner.signTypedData(ctx.domain, { [type]: S.TYPES[type] }, { ...message, ...v }, extra);
  return [v, signature];
}

async function checkOwner(ctx) {
  if (!ctx.owner || !ctx.submit) throw new Error("this command needs the owner's key and a way to send");
  const onChain = await ctx.registry.owner();
  if (getAddress(onChain) !== getAddress(ctx.owner.address)) {
    throw new Error(`the key ${ctx.owner.address} is not the registry's owner (${onChain})`);
  }
}

/** Reads logs in block ranges, so that RPC nodes with a range limit still answer. */
async function scanLogs(ctx, filter, step = 50000) {
  const latest = await ctx.provider.getBlockNumber();
  const logs = [];
  for (let from = ctx.fromBlock; from <= latest; from += step) {
    const to = Math.min(from + step - 1, latest);
    logs.push(...(await ctx.registry.queryFilter(filter, from, to)));
  }
  return logs;
}

// ------------------------------------------------------------------------------------------------
// Factory and registry creation (ChainIntegrate)
// ------------------------------------------------------------------------------------------------

/**
 * Deploys the factory (and with it the registry implementation), owned by `deployer`. `version` 2: the
 * contracts of the external review (contracts/GasCylinderRegistryV2.sol, DESIGN.md §10.1).
 */
async function deployFactory(deployer, version = 1) {
  const name = version === 2 ? "GasCylinderRegistryFactoryV2" : "GasCylinderRegistryFactory";
  const { bytecode } = require(`../../shared/abi/${name}.bytecode.json`);
  const factory = await new ContractFactory(version === 2 ? FACTORY_ABI : FACTORY_V1_ABI, bytecode, deployer).deploy(deployer.address);
  const receipt = await factory.deploymentTransaction().wait();
  return { address: await factory.getAddress(), block: receipt.blockNumber };
}

/**
 * Prepares a new registry: a random salt and its predicted address. The register is created **without**
 * its data key (review X-02): the owner makes the key, the password and the recovery code in their own
 * admin page at the first sign-in (prepareKeys, initializeKeys), so that whoever creates the register
 * never sees them.
 */
async function prepareRegistry({ factory, salt = hexlify(randomBytes(32)) }) {
  const address = await factory.predictRegistryAddress(salt);
  return { salt, address };
}

/**
 * Makes a register's data key, wrapped with the owner's password and with a new 24-word recovery code:
 * { dek, recoveryCode, dataKeys, dataValues }. Nothing is written: show the code, then initializeKeys.
 */
async function prepareKeys(registryAddress, password, language = "it") {
  const check = S.checkPassword(password);
  if (!check.ok) throw new Error(`password refused: ${check.reason}`);
  const address = getAddress(registryAddress);
  const dek = S.generateDataKey();
  const recoveryCode = S.generateRecoveryCode(language);
  return {
    dek,
    recoveryCode,
    dataKeys: [S.KEY_WRAP_DATA_KEYS.password, S.KEY_WRAP_DATA_KEYS.recovery],
    dataValues: [await S.wrapWithPassword(dek, password, address), await S.wrapWithRecoveryCode(dek, recoveryCode, address)],
  };
}

/** True when the register already has its data key (either wrap written). */
async function hasDataKey(ctx) {
  const [a, b] = await Promise.all([ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.password), ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.recovery)]);
  return a !== "0x" || b !== "0x";
}

/**
 * Writes the wraps made by prepareKeys, once: a register that already has its data key is refused, since
 * a second key would make the data written with the first unreadable. Returns { dek, keys }.
 */
async function initializeKeys(ctx, prepared) {
  if (await hasDataKey(ctx)) throw new Error("this registry already has its data key");
  await setData(ctx, prepared.dataKeys, prepared.dataValues);
  const written = await ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.password);
  if (written !== prepared.dataValues[0]) throw new Error("the registry's data key is not the one just made: reload the page");
  return { dek: prepared.dek, keys: await S.deriveKeys(prepared.dek, ctx.address) };
}

/** Creates the prepared registry; `factory` must be connected to the factory's owner. */
async function createRegistry({ factory, prepared, owner, name, symbol, log = () => {} }) {
  let tx;
  try {
    tx = await factory.createRegistry(prepared.salt, getAddress(owner), name, symbol);
    const receipt = await tx.wait();
    return { address: prepared.address, block: receipt.blockNumber };
  } catch (e) {
    // A slow node can time out after the transaction left: look for the registry before giving up.
    if (!/timeout|TIMEOUT|network|ECONNRESET|socket/i.test(String(e.code || e.message))) throw e;
    log("The network did not answer in time: checking whether the register was created…");
    for (let i = 0; i < 30; i++) {
      try {
        if (await factory.isRegistry(prepared.address)) return findRegistry(factory, prepared.address);
      } catch {
        /* the node again: try later */
      }
      await new Promise((r) => setTimeout(r, 10000));
    }
    throw new Error(`no answer for 5 minutes: check later with "use-registry ${prepared.address}"`);
  }
}

/** A registry made by `factory`: { address, block } (its creation block, from the RegistryCreated event). */
async function findRegistry(factory, address, fromBlock = 0) {
  const a = getAddress(address);
  if (!(await factory.isRegistry(a))) throw new Error(`${a} is not a register of this factory`);
  const provider = factory.runner.provider || factory.runner;
  const latest = await provider.getBlockNumber();
  for (let to = latest; to >= fromBlock; to -= 10000) {
    const from = Math.max(fromBlock, to - 9999);
    const logs = await factory.queryFilter(factory.filters.RegistryCreated(a), from, to);
    if (logs.length) return { address: a, block: logs[0].blockNumber };
  }
  throw new Error(`the creation of ${a} was not found`);
}

// ------------------------------------------------------------------------------------------------
// Data key
// ------------------------------------------------------------------------------------------------

/** The register's keys from its current data key: the key epoch and ring are read from the register. */
async function openKeys(ctx, dek) {
  const [epoch, ring] = await Promise.all([ctx.registry.getData(S.KEY_EPOCH_DATA_KEY), ctx.registry.getData(S.KEY_RING_DATA_KEY)]);
  return S.openKeys(dek, ctx.address, epoch, ring);
}

/** Opens the data key with the password. Returns { dek, keys }. */
async function unlockWithPassword(ctx, password) {
  const wrap = await ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.password);
  if (wrap === "0x") throw new Error("this registry has no password key wrap");
  const dek = await S.unwrapWithPassword(wrap, password, ctx.address);
  return { dek, keys: await openKeys(ctx, dek) };
}

/** Opens the data key with the recovery code. Returns { dek, keys }. */
async function unlockWithRecoveryCode(ctx, code) {
  const wrap = await ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.recovery);
  if (wrap === "0x") throw new Error("this registry has no recovery key wrap");
  const dek = await S.unwrapWithRecoveryCode(wrap, code, ctx.address);
  return { dek, keys: await openKeys(ctx, dek) };
}

/**
 * Writes a new data key prepared with S.replaceDataKey (review A05), once its recovery code has been
 * written down: new password and recovery wraps, the epoch and the key ring, in one SetData. Returns
 * { dek, keys } of the new key.
 */
async function applyDataKey(ctx, prepared) {
  const current = await ctx.registry.getData(S.KEY_EPOCH_DATA_KEY);
  const epoch = current === "0x" ? 0 : Number(BigInt(current));
  if (prepared.keys.epoch !== epoch + 1) throw new Error("the data key changed meanwhile: open the register again");
  await setData(ctx, prepared.dataKeys, prepared.dataValues);
  if ((await ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.password)) !== prepared.dataValues[0]) {
    throw new Error("the registry's data key is not the one just made: reload the page");
  }
  return { dek: prepared.dek, keys: prepared.keys };
}

// ------------------------------------------------------------------------------------------------
// Owner-signed writes
// ------------------------------------------------------------------------------------------------

async function setData(ctx, dataKeys, dataValues) {
  await checkOwner(ctx);
  // The values travel with the request too (`extra.dataValues`): the ChainIntegrate Account extension
  // checks them against dataValuesHash and describes each change by its kind (review A02/G-04).
  const [v, signature] = await signAsOwner(ctx, "SetData", { dataKeys, dataValuesHash: S.hashDataValues(dataValues) }, { dataValues });
  return ctx.submit(ctx.address, "setDataSigned", [dataKeys, dataValues, v, signature]);
}

/**
 * Writes one entry only if nobody changed it since `seen` was read (several admin computers): the value
 * is read again just before signing and just after the write. Throws an error with code "CHANGED" when
 * another computer changed it first; the caller reads it again and shows it.
 */
async function setDataChecked(ctx, dataKey, value, seen) {
  if ((await ctx.registry.getData(dataKey)) !== seen) {
    throw Object.assign(new Error("another computer changed this meanwhile"), { code: "CHANGED" });
  }
  const receipt = await setData(ctx, [dataKey], [value]);
  if ((await ctx.registry.getData(dataKey)) !== value) {
    throw Object.assign(new Error("another computer changed this meanwhile"), { code: "CHANGED" });
  }
  return receipt;
}

/** Replaces the password: the data key, opened by the caller with the old password or the recovery code, is wrapped again. */
async function changePassword(ctx, dek, newPassword) {
  const check = S.checkPassword(newPassword);
  if (!check.ok) throw new Error(`password refused: ${check.reason}`);
  return setData(ctx, [S.KEY_WRAP_DATA_KEYS.password], [await S.wrapWithPassword(dek, newPassword, ctx.address)]);
}

async function setOperator(ctx, operator, enabled) {
  await checkOwner(ctx);
  const address = getAddress(operator);
  if ((await ctx.registry.isOperator(address)) === enabled) {
    throw new Error(`${address} is ${enabled ? "already" : "not"} an operator`);
  }
  const [v, signature] = await signAsOwner(ctx, "SetOperator", { operator: address, enabled });
  return ctx.submit(ctx.address, "setOperatorSigned", [address, enabled, v, signature]);
}

// ------------------------------------------------------------------------------------------------
// Ownership (3 days between start and acceptance) and cancelled signatures
// ------------------------------------------------------------------------------------------------

/** Starts handing the register to `newOwner`: it can accept 3 days later; until then the owner can cancel. */
async function transferOwnership(ctx, newOwner) {
  await checkOwner(ctx);
  const address = getAddress(newOwner);
  const [v, signature] = await signAsOwner(ctx, "TransferOwnership", { newOwner: address });
  return ctx.submit(ctx.address, "transferOwnershipSigned", [address, v, signature]);
}

/** Cancels the pending handover. */
async function cancelOwnershipTransfer(ctx) {
  await checkOwner(ctx);
  const pending = await ctx.registry.pendingOwner();
  if (/^0x0{40}$/i.test(pending)) throw new Error("no handover is pending");
  const [v, signature] = await signAsOwner(ctx, "CancelOwnershipTransfer", { pendingOwner: pending });
  return ctx.submit(ctx.address, "cancelOwnershipTransferSigned", [pending, v, signature]);
}

/** The new owner (ctx.owner) accepts the handover, once it is ready. */
async function acceptOwnership(ctx) {
  if (!ctx.owner || !ctx.submit) throw new Error("this command needs the new owner's key and a way to send");
  const [pending, readyAt] = await Promise.all([ctx.registry.pendingOwner(), ctx.registry.ownershipTransferReadyAt()]);
  if (getAddress(pending) !== getAddress(ctx.owner.address)) throw new Error(`${ctx.owner.address} is not the pending owner`);
  const block = await ctx.provider.getBlock("latest");
  if (BigInt(block.timestamp) < readyAt) throw new Error(`the handover can be accepted from ${new Date(Number(readyAt) * 1000).toISOString()}`);
  const [v, signature] = await signAsOwner(ctx, "AcceptOwnership", { newOwner: getAddress(pending) });
  return ctx.submit(ctx.address, "acceptOwnershipSigned", [v, signature]);
}

/** The owner cancels unsent signatures of `signer` (a phone) by their nonces (review G-07). */
async function cancelNonces(ctx, signer, nonces) {
  await checkOwner(ctx);
  const list = nonces.map((n) => BigInt(n));
  const [v, signature] = await signAsOwner(ctx, "CancelNonces", { signer: getAddress(signer), nonces: list });
  return ctx.submit(ctx.address, "cancelNoncesSigned", [getAddress(signer), list, getAddress(ctx.owner.address), v, signature]);
}

// ------------------------------------------------------------------------------------------------
// Corrections (review A06: a registered cylinder's information is corrected by the owner)
// ------------------------------------------------------------------------------------------------

/**
 * Corrects one cylinder: its information (gas, litres, owner, years between tests) and its periodic test,
 * with a reason. Recorded as a "correction" document signed by the owner, which stays in the cylinder's
 * history. `changes`: { gas?, capacityL?, owner?, testYears?, test? } (`test` as validateTest; null for no
 * change). Returns { docId, receipt }.
 */
async function correctCylinder(ctx, keys, tokenId, changes, reason) {
  await checkOwner(ctx);
  const [rawInfo, rawState] = await ctx.registry.getDataBatchForTokenIds([tokenId, tokenId], [S.INFO_KEY, S.STATE_KEY]);
  if (rawInfo === "0x") throw new Error("this cylinder has no information to correct");
  const info = S.validateInfo(await S.decryptValue(keys, tokenId, "info", rawInfo));
  const state = rawState === "0x" ? null : S.validateState(await S.decryptValue(keys, tokenId, "state", rawState));
  const next = S.validateInfo({ ...info, ...pick(changes, ["gas", "capacityL", "owner", "testYears"]), v: 1 });
  if (changes.capacityL === null) delete next.capacityL;
  const updates = [];
  if (JSON.stringify(next) !== JSON.stringify(info)) {
    updates.push({ tokenId, dataKey: S.INFO_KEY, expectedHash: keccak256(rawInfo), newValue: await S.encryptValue(keys, tokenId, "info", next) });
  }
  let test;
  if (changes.test) {
    if (!state) throw new Error("this cylinder has no state yet: its test is written with its first movement");
    test = S.completeTest(changes.test, next.testYears || changes.testYears || S.DEFAULT_TEST_YEARS);
    const nextState = S.validateState({ ...state, test });
    updates.push({ tokenId, dataKey: S.STATE_KEY, expectedHash: keccak256(rawState), newValue: await S.encryptValue(keys, tokenId, "state", nextState) });
  }
  if (!updates.length) throw new Error("nothing to correct");
  const now = (await ctx.provider.getBlock("latest")).timestamp;
  const docId = await S.documentId(keys, ZERO_ADDRESS, `correction:${now}:${S.randomNonce().toString(16)}`);
  const document = S.validateDocument({
    v: 1,
    kind: "correction",
    date: now,
    reason,
    lines: [
      prune({
        tokenId,
        serial: next.serial,
        gas: next.gas,
        movement: "correct",
        condition: state ? state.condition : "full",
        owner: next.owner,
        capacityL: next.capacityL,
        testYears: next.testYears,
        test,
      }),
    ],
  });
  const [payload] = S.withManifest([
    {
      docId,
      part: 0,
      parts: 1,
      manifest: ZeroHash,
      corrects: ZeroHash,
      mints: [],
      updates,
      document: await S.encryptValue(keys, docId, "document", document),
    },
  ]);
  const owner = getAddress(ctx.owner.address);
  const [v, signature] = await signAsOwner(ctx, "RecordDocument", { signer: owner, payloadHash: S.hashPayload(payload) }, { payload });
  const receipt = await ctx.submit(ctx.address, "recordDocument", [payload, owner, v, signature]);
  return { docId, receipt };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const pick = (o, names) => Object.fromEntries(names.filter((n) => o[n] !== undefined && o[n] !== null).map((n) => [n, o[n]]));
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ------------------------------------------------------------------------------------------------
// Counterparties
// ------------------------------------------------------------------------------------------------

/** Adds a customer or a refill plant. Returns its id. */
async function addCounterparty(ctx, keys, fields) {
  const cpId = hexlify(randomBytes(20));
  const value = S.validateCounterparty({ v: 1, ...fields });
  await setData(ctx, [S.counterpartyDataKey(cpId)], [await S.encryptValue(keys, cpId, "counterparty", value)]);
  return cpId;
}

/**
 * Changes a counterparty's name or e-mails. With `seen` (the raw value the page showed), refused with code
 * "CHANGED" when another computer changed it meanwhile.
 */
async function updateCounterparty(ctx, keys, cpId, fields, seen) {
  const key = S.counterpartyDataKey(cpId);
  const raw = seen === undefined ? await ctx.registry.getData(key) : seen;
  if (raw === "0x") throw new Error(`no counterparty ${cpId}`);
  const current = S.validateCounterparty(await S.decryptValue(keys, cpId, "counterparty", raw));
  const value = S.validateCounterparty({ ...current, ...fields, v: 1 });
  return setDataChecked(ctx, key, await S.encryptValue(keys, cpId, "counterparty", value), raw);
}

/** Removes a counterparty from the list (its past documents keep its id). */
/**
 * Takes a counterparty off the lists: it is archived, not erased (review A21), so that its documents keep
 * showing who they were for. The app no longer offers it; the admin page lists it as archived.
 */
async function removeCounterparty(ctx, keys, cpId, seen) {
  return updateCounterparty(ctx, keys, cpId, { archived: true }, seen);
}

async function readCounterparty(ctx, keys, cpId) {
  const raw = await ctx.registry.getData(S.counterpartyDataKey(cpId));
  return raw === "0x" ? null : S.validateCounterparty(await S.decryptValue(keys, cpId, "counterparty", raw));
}

/**
 * All current counterparties, decrypted: [{ id, type, name, emails }]. One that cannot be read (it does
 * not decrypt or is not valid) is left out and reported in `problems` ({ what, id }), so that it never
 * stops the others from loading (review G-08).
 */
async function listCounterparties(ctx, keys, problems = []) {
  const logs = await scanLogs(ctx, ctx.registry.filters.DataChanged());
  const prefix = S.COUNTERPARTY_KEY_PREFIX.toLowerCase();
  const ids = [];
  const seen = new Set();
  for (const l of logs) {
    const key = l.args.dataKey.toLowerCase();
    if (!key.startsWith(prefix)) continue;
    const cpId = "0x" + key.slice(-40);
    if (!seen.has(cpId)) seen.add(cpId) && ids.push(cpId);
  }
  // Read in batches of 100 (hundreds of customers: one call per batch, not per customer).
  const list = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const raws = await ctx.registry.getDataBatch(chunk.map((cpId) => S.counterpartyDataKey(cpId)));
    await Promise.all(
      chunk.map(async (cpId, j) => {
        if (raws[j] === "0x") return;
        try {
          // `raw`: what the page showed, so that a change made meanwhile from another computer is noticed.
          list.push({ id: cpId, raw: raws[j], ...S.validateCounterparty(await S.decryptValue(keys, cpId, "counterparty", raws[j])) });
        } catch {
          problems.push({ what: "counterparty", id: cpId });
        }
      })
    );
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------------------------------------

/** The registry's settings ({ v, company, emails }), or null when they were never set. */
async function readSettings(ctx, keys) {
  const raw = await ctx.registry.getData(S.SETTINGS_DATA_KEY);
  return raw === "0x" ? null : S.validateSettings(await S.decryptValue(keys, S.SETTINGS_DATA_KEY, "settings", raw));
}

/** Sets the company name and/or the supplier's e-mails (fields not given keep their value). */
async function writeSettings(ctx, keys, fields, seen) {
  const raw = seen === undefined ? await ctx.registry.getData(S.SETTINGS_DATA_KEY) : seen;
  // Unreadable settings (badly written) are replaced, so that the owner can always repair them.
  let current = { v: 1, company: "", emails: [] };
  if (raw !== "0x") current = await S.decryptValue(keys, S.SETTINGS_DATA_KEY, "settings", raw).then(S.validateSettings).catch(() => current);
  const value = S.validateSettings({ ...current, ...fields, v: 1 });
  return setDataChecked(ctx, S.SETTINGS_DATA_KEY, await S.encryptValue(keys, S.SETTINGS_DATA_KEY, "settings", value), raw);
}

// ------------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------------

/** Current operators, from the OperatorChanged events checked against the contract. */
async function listOperators(ctx) {
  const logs = await scanLogs(ctx, ctx.registry.filters.OperatorChanged());
  const seen = [...new Set(logs.map((l) => getAddress(l.args.operator)))];
  const current = [];
  for (const a of seen) if (await ctx.registry.isOperator(a)) current.push(a);
  return current;
}

/** A summary of the registry, readable without the data key. */
async function status(ctx) {
  const r = ctx.registry;
  const [owner, pendingOwner, readyAt, epoch, operators, cylinders, name, passwordWrap, recoveryWrap] = await Promise.all([
    r.owner(),
    r.pendingOwner(),
    r.ownershipTransferReadyAt(),
    r.getData(S.KEY_EPOCH_DATA_KEY),
    r.operatorCount(),
    r.totalSupply(),
    r.getData(id("LSP4TokenName")),
    r.getData(S.KEY_WRAP_DATA_KEYS.password),
    r.getData(S.KEY_WRAP_DATA_KEYS.recovery),
  ]);
  return {
    registry: ctx.address,
    chainId: Number(ctx.chainId),
    name: name === "0x" ? "" : toUtf8String(name), // also in the browser (the admin page)
    owner,
    pendingOwner: pendingOwner === ZERO_ADDRESS ? null : pendingOwner,
    handoverReadyAt: pendingOwner === ZERO_ADDRESS ? null : Number(readyAt),
    keyEpoch: epoch === "0x" ? 0 : Number(BigInt(epoch)),
    operators: Number(operators),
    cylinders: Number(cylinders),
    passwordKeyWrap: passwordWrap !== "0x",
    recoveryKeyWrap: recoveryWrap !== "0x",
  };
}

module.exports = {
  prepareKeys,
  hasDataKey,
  initializeKeys,
  REGISTRY_ABI,
  FACTORY_ABI,
  FACTORY_V1_ABI,
  directSubmitter,
  relayerSubmitter,
  context,
  deployFactory,
  prepareRegistry,
  createRegistry,
  findRegistry,
  openKeys,
  unlockWithPassword,
  unlockWithRecoveryCode,
  applyDataKey,
  setData,
  setDataChecked,
  transferOwnership,
  cancelOwnershipTransfer,
  acceptOwnership,
  cancelNonces,
  correctCylinder,
  signAsOwner,
  changePassword,
  setOperator,
  addCounterparty,
  updateCounterparty,
  removeCounterparty,
  readCounterparty,
  listCounterparties,
  listOperators,
  readSettings,
  writeSettings,
  status,
};
