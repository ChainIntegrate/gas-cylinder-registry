"use strict";
// Gas used by recordDocument for documents of different sizes (version 2, local Hardhat network).
// Run: npx hardhat run scripts/gas-report.js
const { ethers } = require("hardhat");
const E = require("../shared/eip712");

async function main() {
  const [ci, owner, driver, relayer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const factory = await ethers.deployContract("GasCylinderRegistryFactoryV2", [ci.address]);
  const rc = await (await factory.createRegistry(ethers.ZeroHash, owner.address, "Argonia Gas Tecnici cylinders", "ARGCYL")).wait();
  const reg = await ethers.getContractAt("GasCylinderRegistryV2", factory.interface.parseLog(rc.logs.at(-1)).args.registry);
  const dom = E.domain(await reg.getAddress(), chainId);
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  {
    const v = E.validity(await now(), 3600);
    const sig = await owner.signTypedData(dom, { SetOperator: E.TYPES.SetOperator }, { operator: driver.address, enabled: true, ...v });
    await (await reg.connect(relayer).setOperatorSigned(driver.address, true, v, sig)).wait();
  }
  const info = () => ethers.hexlify(ethers.randomBytes(221)); // an encrypted info value (always 221 bytes)
  const state = () => ethers.hexlify(ethers.randomBytes(285)); // an encrypted state value (always 285 bytes)
  const send = async (part) => {
    const [p] = E.withManifest([part]);
    const v = E.validity(await now(), 3600);
    const sig = await driver.signTypedData(dom, { RecordDocument: E.TYPES.RecordDocument }, { signer: driver.address, payloadHash: E.hashPayload(p), ...v });
    return (await (await reg.connect(relayer).recordDocument(p, driver.address, v, sig)).wait()).gasUsed;
  };
  const doc = (mints, updates) => ({ docId: ethers.hexlify(ethers.randomBytes(32)), part: 0, parts: 1, corrects: ethers.ZeroHash, mints, updates, document: ethers.hexlify(ethers.randomBytes(512)) });
  for (const n of [1, 10, 25]) {
    const ids = Array.from({ length: n }, () => ethers.hexlify(ethers.randomBytes(32)));
    const updates = ids.flatMap((t) => [
      { tokenId: t, dataKey: E.INFO_KEY, expectedHash: E.EMPTY_HASH, newValue: info() },
      { tokenId: t, dataKey: E.STATE_KEY, expectedHash: E.EMPTY_HASH, newValue: state() },
    ]);
    const gNew = await send(doc(ids, updates));
    const moves = await Promise.all(ids.map(async (t) => ({ tokenId: t, dataKey: E.STATE_KEY, expectedHash: ethers.keccak256(await reg.getDataForTokenId(t, E.STATE_KEY)), newValue: state() })));
    const gMove = await send(doc([], moves));
    console.log(`${n} cylinders: new ${gNew} gas, ${(Number(gNew) / n) | 0}/cylinder; movement only ${gMove} gas, ${(Number(gMove) / n) | 0}/cylinder`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
