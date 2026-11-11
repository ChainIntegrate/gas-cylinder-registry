# gas-cylinder-registry

Tracking of technical gas cylinders on LUKSO: one LSP8 token per cylinder, data encrypted on-chain, a
scanning app for drivers and a gasless relayer.

**Status: design.** Nothing is implemented yet; the structure is in [DESIGN.md](DESIGN.md).

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
