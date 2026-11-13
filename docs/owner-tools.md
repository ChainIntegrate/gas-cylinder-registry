# ChainIntegrate's command-line tools

`scripts/owner.js`: what ChainIntegrate does once per network and once per supplier (the factory, the
registers, the source verification; registers can also be created from the operator page, see
[admin.md](admin.md#the-operator-page-chainintegrate-only)), and the owner operations for an owner that uses a key file instead
of a ChainIntegrate account. A supplier with a ChainIntegrate account manages its register from the
admin page ([admin.md](admin.md)), not from here.

They run with Node.js 20 or later, from a clone of this repository after `npm ci --omit=dev` (`npm ci`
for the source verification, which needs the compiler). On the server they live in the user's home
(`~/gastrace-tools`), apart from the clone that serves the site, because they hold ChainIntegrate's key.

```bash
node scripts/owner.js help
```

## Files

| File | What | In the repository? |
|---|---|---|
| `chainintegrate.keystore.json` | ChainIntegrate's key: deploys the factory, creates registers; needs a little LYX | **Never** |
| `owner.keystore.json` | Only for an owner that uses a key file; needs no LYX | **Never** |
| `gcr-registry.json` | Network, factory and register addresses and blocks, which key files to use | No (it may name the company) |

All three are in `.gitignore`. Keep a copy of each key file and its password.

## A new supplier

```bash
# Once: ChainIntegrate's key (send it a little LYX), then the factory
node scripts/owner.js new-key chainintegrate.keystore.json
node scripts/owner.js deploy-factory --network lukso
npx hardhat run --network luksoMainnet scripts/verify-lukso.js     # source on LUKSO's explorer (needs npm ci)

# Once, when the operator page is used: the factory to ChainIntegrate's Universal Profile
node scripts/owner.js transfer-factory 0x<ChainIntegrate's profile>

# Per supplier, from the command line (or from the operator page, see admin.md):
node scripts/owner.js create-registry --network lukso --name "Argonia Gas Tecnici" --symbol ARGCYL \
  --owner 0x<the account's address> --language it
```

`create-registry` asks the data password twice (it refuses a weak one) and shows the **24-word
recovery code once**, asking for two of its words before going on: write it down. The supplier then
does everything else from the admin page.

If the network does not answer while a register is being created, the tools look for it for five
minutes. If they still stop, check whether it exists before trying again (a new attempt makes a new
address and a new recovery code), and save an existing one with `use-registry <address>`.

## Other commands

| Command | What |
|---|---|
| `status` | The register: name, owner, phones, cylinders, key wraps |
| `phone-setup` | The setup code and its QR in the terminal (the admin page shows the same) |
| `use-registry <address>` | Save a register created earlier into `gcr-registry.json` |
| `transfer-factory <address>` | Hand the factory over to ChainIntegrate's Universal Profile, in one final step: the address must answer as a profile (LSP0), and you retype its last six characters |

For an owner with a key file (`--owner-keystore` at creation), the owner operations are here too:
`settings`, `counterparties`, `add-customer`, `add-refill-plant`, `edit-counterparty`,
`remove-counterparty`, `phones`, `add-phone`, `remove-phone`, `change-password [--recovery]`. Each is
signed with the owner's key file and sent through the relayer (`"relayer"` in `gcr-registry.json`) or,
without one, by ChainIntegrate's key.

## Networks

`--network lukso` (default) uses `LUKSO_RPC_URL` or LUKSO's public node; `lukso-testnet` and `local`
exist for tests. If the public node is slow, set `LUKSO_RPC_URL` to ChainIntegrate's node for the
command.
