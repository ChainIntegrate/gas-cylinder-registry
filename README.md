# gas-cylinder-registry

Tracking of technical gas cylinders on LUKSO: one LSP8 token per cylinder, data encrypted on-chain, a
scanning app for drivers and a gasless relayer.

**Status: milestones 1 to 3 of the [design](DESIGN.md).** The contracts (registry and factory), the
shared library (encryption, key wraps, identifiers, formats) and the owner tools
([guide](docs/owner-tools.md)) are written and tested on a local chain; nothing is deployed yet. The
relayer and the app follow.

## Development

```bash
npm install
npx hardhat compile        # solc 0.8.28 from npm (solc-js), no compiler download
npx hardhat test
npx hardhat run scripts/gas-report.js
node scripts/export-abi.js   # after changing the contracts: ABIs for the tools, relayer and app
node scripts/owner.js help   # owner tools
```

## In short

- Each cylinder is a token in the supplier's own LSP8 collection; its identifier is derived from the
  barcode with a secret key, so serial numbers never appear on-chain.
- Cylinder data, states, customers and delivery notes are stored on-chain, encrypted with a key that
  only the supplier controls.
- The driver's app scans the barcodes at delivery and collection, knows each cylinder's last state,
  records the delivery note in one signed operation and e-mails a summary.
- Nobody at the supplier holds LYX: the app signs, ChainIntegrate's relayer sends and pays the gas.
- One registry per company, created by a factory; the owner can be an EOA or a Universal Profile.

The examples use a fictional supplier, Argonia Gas Tecnici.

## License

Source available, all rights reserved: see [LICENSE](LICENSE). Third-party components:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
