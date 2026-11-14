"use strict";
// What the admin page reads from a registry, decrypted with the data key: the registries an account owns,
// the cylinders with their current state, the documents, and one cylinder's history. No interface here.

const { Contract, getAddress, id } = require("ethers");
const S = require("../../shared");
const REGISTRY_ABI = require("../../shared/abi/GasCylinderRegistry.json");
const FACTORY_ABI = require("../../shared/abi/GasCylinderRegistryFactory.json");

/** Reads logs in block ranges, halving the range when a node refuses it. */
async function scan(contract, filter, fromBlock, provider) {
  const latest = await provider.getBlockNumber();
  const out = [];
  let step = 100000;
  for (let from = fromBlock; from <= latest; ) {
    const to = Math.min(from + step - 1, latest);
    try {
      out.push(...(await contract.queryFilter(filter, from, to)));
      from = to + 1;
    } catch (e) {
      if (step <= 1000) throw e;
      step = Math.floor(step / 2);
    }
  }
  return out;
}

/**
 * The registries created for `account` that it still owns, and those handed over to it:
 * [{ address, name, block }].
 */
async function registriesOf(provider, factoryAddress, account, fromBlock = 0) {
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
  const me = getAddress(account);
  const created = await scan(factory, factory.filters.RegistryCreated(), fromBlock, provider);
  const out = [];
  for (const l of created) {
    const reg = new Contract(l.args.registry, REGISTRY_ABI, provider);
    if (getAddress(await reg.owner()) === me) out.push({ address: getAddress(l.args.registry), name: l.args.name, block: l.blockNumber });
  }
  return out;
}

/**
 * Every cylinder of the registry: [{ tokenId, info, state }], sorted by serial. A value that cannot be
 * read (it does not decrypt or is not valid) never stops the others (review G-08): a cylinder whose
 * information is unreadable is left out, one whose state is unreadable keeps state null; each is
 * reported in `problems` ({ what, id, field }).
 */
async function cylinders(registry, keys, fromBlock, provider, problems = []) {
  const ids = new Set();
  const logs = await scan(registry, registry.filters.TokenIdDataChanged(null, S.INFO_KEY), fromBlock, provider);
  for (const l of logs) ids.add(l.args.tokenId);
  const list = [...ids];
  const out = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const values = await registry.getDataBatchForTokenIds(
      chunk.flatMap((t) => [t, t]),
      chunk.flatMap(() => [S.INFO_KEY, S.STATE_KEY])
    );
    for (let j = 0; j < chunk.length; j++) {
      const t = chunk[j];
      const [rawInfo, rawState] = [values[2 * j], values[2 * j + 1]];
      if (rawInfo === "0x") continue;
      let info;
      try {
        info = S.validateInfo(await S.decryptValue(keys, t, "info", rawInfo));
      } catch {
        problems.push({ what: "cylinder", id: t, field: "info" });
        continue;
      }
      let state = null;
      if (rawState !== "0x") {
        try {
          state = S.validateState(await S.decryptValue(keys, t, "state", rawState));
        } catch {
          problems.push({ what: "cylinder", id: t, field: "state", serial: info.serial });
        }
      }
      out.push({ tokenId: t, info, state });
    }
  }
  return out.sort((a, b) => a.info.serial.localeCompare(b.info.serial));
}

/**
 * The recorded documents, newest first: [{ docId, document, signer, corrects, tx, block, time }].
 * A document split in parts carries its content in one part only.
 */
async function documents(registry, keys, fromBlock, provider) {
  const logs = await scan(registry, registry.filters.DocumentRecorded(), fromBlock, provider);
  const byDoc = new Map();
  for (const l of logs) {
    const d = byDoc.get(l.args.docId) || { docId: l.args.docId, txs: [], signer: l.args.signer, corrects: l.args.corrects, block: l.blockNumber };
    d.txs.push(l.transactionHash);
    d.block = Math.max(d.block, l.blockNumber);
    if (l.args.document && l.args.document !== "0x") {
      try {
        d.document = S.validateDocument(await S.decryptValue(keys, l.args.docId, "document", l.args.document));
      } catch {
        d.unreadable = true;
      }
    }
    byDoc.set(l.args.docId, d);
  }
  return [...byDoc.values()].sort((a, b) => b.block - a.block);
}

/** One cylinder's history, oldest first: [{ state, unreadable, tx, block, document }] (state null when unreadable). */
async function history(registry, keys, tokenId, fromBlock, provider, docs = []) {
  const logs = await scan(registry, registry.filters.TokenIdDataChanged(tokenId, S.STATE_KEY), fromBlock, provider);
  const docByTx = new Map();
  for (const d of docs) for (const tx of d.txs) docByTx.set(tx, d);
  const out = [];
  for (const l of logs) {
    const d = docByTx.get(l.transactionHash);
    let state = null;
    try {
      state = S.validateState(await S.decryptValue(keys, tokenId, "state", l.args.dataValue));
    } catch {
      // shown as an unreadable movement, the others still are
    }
    out.push({ state, unreadable: !state, tx: l.transactionHash, block: l.blockNumber, document: d ? d.document : null });
  }
  return out;
}

/** Counts for the overview. */
function overview(list) {
  const c = { total: 0, depot: 0, customer: 0, refill: 0, full: 0, empty: 0, defective: 0, retired: 0, byGas: {} };
  for (const x of list) {
    c.total++;
    c.byGas[x.info.gas] = (c.byGas[x.info.gas] || 0) + 1;
    if (!x.state) continue;
    if (x.state.lifecycle === "retired") {
      c.retired++;
      continue;
    }
    c[x.state.location.type]++;
    c[x.state.condition]++;
  }
  return c;
}

/** The registry's display name as its LSP4 name says. */
async function registryName(registry) {
  const raw = await registry.getData(id("LSP4TokenName"));
  return raw === "0x" ? "" : new TextDecoder().decode(Uint8Array.from(raw.slice(2).match(/../g).map((h) => parseInt(h, 16))));
}

module.exports = { scan, registriesOf, cylinders, documents, history, overview, registryName, REGISTRY_ABI, FACTORY_ABI };
