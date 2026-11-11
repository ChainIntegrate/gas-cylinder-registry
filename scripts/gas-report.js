"use strict";
// Gas used by recordDocument for documents of different sizes (local Hardhat network).
// Run: npx hardhat run scripts/gas-report.js
const { ethers } = require("hardhat");
const E = require("../shared/eip712");

async function main() {
  const [ci, owner, driver, relayer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const factory = await ethers.deployContract("GasCylinderRegistryFactory", [ci.address]);
  const rc = await (await factory.createRegistry(ethers.ZeroHash, owner.address, "Argonia Gas Tecnici cylinders", "ARGCYL", [], [])).wait();
  const reg = await ethers.getContractAt("GasCylinderRegistry", factory.interface.parseLog(rc.logs.at(-1)).args.registry);
  await reg.connect(owner).setOperator(driver.address, true);
  const dom = E.domain(await reg.getAddress(), chainId);
  const value = () => ethers.hexlify(ethers.randomBytes(221)); // an encrypted info or state value (always 221 bytes)
  const send = async (p) => {
    const nonce = E.randomNonce();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await driver.signTypedData(dom, { RecordDocument: E.TYPES.RecordDocument }, { signer: driver.address, payloadHash: E.hashPayload(p), nonce, deadline });
    return (await (await reg.connect(relayer).recordDocument(p, driver.address, nonce, deadline, sig)).wait()).gasUsed;
  };
  const doc = (mints, updates) => ({ docId: ethers.hexlify(ethers.randomBytes(32)), part: 0, parts: 1, corrects: ethers.ZeroHash, mints, updates, document: ethers.hexlify(ethers.randomBytes(512)) });
  for (const n of [1, 10, 25]) {
    const ids = Array.from({ length: n }, () => ethers.hexlify(ethers.randomBytes(32)));
    const updates = ids.flatMap((t) => [
      { tokenId: t, dataKey: E.INFO_KEY, expectedHash: E.EMPTY_HASH, newValue: value() },
      { tokenId: t, dataKey: E.STATE_KEY, expectedHash: E.EMPTY_HASH, newValue: value() },
    ]);
    const gNew = await send(doc(ids, updates));
    const moves = await Promise.all(ids.map(async (t) => ({ tokenId: t, dataKey: E.STATE_KEY, expectedHash: ethers.keccak256(await reg.getDataForTokenId(t, E.STATE_KEY)), newValue: value() })));
    const gMove = await send(doc([], moves));
    console.log(`${n} cylinders: new ${gNew} gas, ${Number(gNew) / n | 0}/cylinder; movement only ${gMove} gas, ${Number(gMove) / n | 0}/cylinder`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
