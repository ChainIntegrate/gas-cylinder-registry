"use strict";
// The owner tools' logic, without any user interface: the command line (scripts/owner.js) and the
// tests call these functions. Every write is an owner-signed operation handed to `submit`, which sends
// it through the relayer or, until the relayer exists, from a funded submitter key.

const { Contract, ContractFactory, getAddress, hexlify, randomBytes, id } = require("ethers");
const S = require("../../shared");
const REGISTRY_ABI = require("../../shared/abi/GasCylinderRegistry.json");
const FACTORY_ABI = require("../../shared/abi/GasCylinderRegistryFactory.json");

const OWNER_DEADLINE_SECONDS = 3600;

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

async function deadline(ctx) {
  const block = await ctx.provider.getBlock("latest");
  return BigInt(block.timestamp + OWNER_DEADLINE_SECONDS);
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

/** Deploys the factory (and with it the registry implementation), owned by `deployer`. */
async function deployFactory(deployer) {
  const { bytecode } = require("../../shared/abi/GasCylinderRegistryFactory.bytecode.json");
  const factory = await new ContractFactory(FACTORY_ABI, bytecode, deployer).deploy(deployer.address);
  const receipt = await factory.deploymentTransaction().wait();
  return { address: await factory.getAddress(), block: receipt.blockNumber };
}

/**
 * Prepares a registry before creating it: its future address, a new data key, the recovery code and
 * the two key wraps bound to that address. Nothing is sent. The caller shows the recovery code once.
 */
async function prepareRegistry({ factory, password, language = "en", salt = hexlify(randomBytes(32)) }) {
  const check = S.checkPassword(password);
  if (!check.ok) throw new Error(`password refused: ${check.reason}`);
  const address = await factory.predictRegistryAddress(salt);
  const dek = S.generateDataKey();
  const recoveryCode = S.generateRecoveryCode(language);
  return {
    salt,
    address,
    recoveryCode,
    dataKeys: [S.KEY_WRAP_DATA_KEYS.password, S.KEY_WRAP_DATA_KEYS.recovery],
    dataValues: [await S.wrapWithPassword(dek, password, address), await S.wrapWithRecoveryCode(dek, recoveryCode, address)],
  };
}

/** Creates the prepared registry; `factory` must be connected to the factory's owner. */
async function createRegistry({ factory, prepared, owner, name, symbol }) {
  const tx = await factory.createRegistry(prepared.salt, getAddress(owner), name, symbol, prepared.dataKeys, prepared.dataValues);
  const receipt = await tx.wait();
  return { address: prepared.address, block: receipt.blockNumber };
}

// ------------------------------------------------------------------------------------------------
// Data key
// ------------------------------------------------------------------------------------------------

/** Opens the data key with the password. Returns { dek, keys }. */
async function unlockWithPassword(ctx, password) {
  const wrap = await ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.password);
  if (wrap === "0x") throw new Error("this registry has no password key wrap");
  const dek = await S.unwrapWithPassword(wrap, password, ctx.address);
  return { dek, keys: await S.deriveKeys(dek, ctx.address) };
}

/** Opens the data key with the recovery code. Returns { dek, keys }. */
async function unlockWithRecoveryCode(ctx, code) {
  const wrap = await ctx.registry.getData(S.KEY_WRAP_DATA_KEYS.recovery);
  if (wrap === "0x") throw new Error("this registry has no recovery key wrap");
  const dek = await S.unwrapWithRecoveryCode(wrap, code, ctx.address);
  return { dek, keys: await S.deriveKeys(dek, ctx.address) };
}

// ------------------------------------------------------------------------------------------------
// Owner-signed writes
// ------------------------------------------------------------------------------------------------

async function setData(ctx, dataKeys, dataValues) {
  await checkOwner(ctx);
  const nonce = S.randomNonce();
  const dl = await deadline(ctx);
  const signature = await ctx.owner.signTypedData(
    ctx.domain,
    { SetData: S.TYPES.SetData },
    { dataKeys, dataValuesHash: S.hashDataValues(dataValues), nonce, deadline: dl }
  );
  return ctx.submit(ctx.address, "setDataSigned", [dataKeys, dataValues, nonce, dl, signature]);
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
  const nonce = S.randomNonce();
  const dl = await deadline(ctx);
  const signature = await ctx.owner.signTypedData(
    ctx.domain,
    { SetOperator: S.TYPES.SetOperator },
    { operator: address, enabled, nonce, deadline: dl }
  );
  return ctx.submit(ctx.address, "setOperatorSigned", [address, enabled, nonce, dl, signature]);
}

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

/** Changes a counterparty's name or e-mails. */
async function updateCounterparty(ctx, keys, cpId, fields) {
  const current = await readCounterparty(ctx, keys, cpId);
  if (!current) throw new Error(`no counterparty ${cpId}`);
  const value = S.validateCounterparty({ ...current, ...fields, v: 1 });
  return setData(ctx, [S.counterpartyDataKey(cpId)], [await S.encryptValue(keys, cpId, "counterparty", value)]);
}

/** Removes a counterparty from the list (its past documents keep its id). */
async function removeCounterparty(ctx, cpId) {
  return setData(ctx, [S.counterpartyDataKey(cpId)], ["0x"]);
}

async function readCounterparty(ctx, keys, cpId) {
  const raw = await ctx.registry.getData(S.counterpartyDataKey(cpId));
  return raw === "0x" ? null : S.validateCounterparty(await S.decryptValue(keys, cpId, "counterparty", raw));
}

/** All current counterparties, decrypted: [{ id, type, name, emails }]. */
async function listCounterparties(ctx, keys) {
  const logs = await scanLogs(ctx, ctx.registry.filters.DataChanged());
  const prefix = S.COUNTERPARTY_KEY_PREFIX.toLowerCase();
  const ids = new Set();
  for (const l of logs) {
    const key = l.args.dataKey.toLowerCase();
    if (key.startsWith(prefix)) ids.add("0x" + key.slice(-40));
  }
  const list = [];
  for (const cpId of ids) {
    const cp = await readCounterparty(ctx, keys, cpId);
    if (cp) list.push({ id: cpId, ...cp });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
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
  const [owner, pendingOwner, operators, cylinders, name, passwordWrap, recoveryWrap] = await Promise.all([
    r.owner(),
    r.pendingOwner(),
    r.operatorCount(),
    r.totalSupply(),
    r.getData(id("LSP4TokenName")),
    r.getData(S.KEY_WRAP_DATA_KEYS.password),
    r.getData(S.KEY_WRAP_DATA_KEYS.recovery),
  ]);
  return {
    registry: ctx.address,
    chainId: Number(ctx.chainId),
    name: Buffer.from(name.slice(2), "hex").toString("utf8"),
    owner,
    pendingOwner: pendingOwner === "0x0000000000000000000000000000000000000000" ? null : pendingOwner,
    operators: Number(operators),
    cylinders: Number(cylinders),
    passwordKeyWrap: passwordWrap !== "0x",
    recoveryKeyWrap: recoveryWrap !== "0x",
  };
}

module.exports = {
  REGISTRY_ABI,
  FACTORY_ABI,
  directSubmitter,
  context,
  deployFactory,
  prepareRegistry,
  createRegistry,
  unlockWithPassword,
  unlockWithRecoveryCode,
  setData,
  changePassword,
  setOperator,
  addCounterparty,
  updateCounterparty,
  removeCounterparty,
  readCounterparty,
  listCounterparties,
  listOperators,
  status,
};
