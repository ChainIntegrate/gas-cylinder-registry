# ChainIntegrate's command-line tools

`scripts/owner.js`: what ChainIntegrate does once per network and once per supplier (the factory, the
registers, the source verification; registers can also be created from the operator page, see
[admin.md](admin.md#the-operator-page-chainintegrate-only)), and the owner operations for an owner that uses a key file instead
of a ChainIntegrate account. A supplier with a ChainIntegrate account manages its register from the
admin page ([admin.md](admin.md)), not from here.

They run with Node.js 20 or later, from a clone of this repository after `npm ci --omit=dev` (`npm ci`
for the source verification, which needs the compiler). On the server they live in the user's home
(`~/gastrace-tools`), apart from the clone that serves the site, because they hold ChainIntegrate's key.
Now that the factory belongs to ChainIntegrate's Universal Profile, that key is no longer needed on the
public server: keep it offline (review X-05).

```bash
node scripts/owner.js help
```

They work on **version 2** of the contracts (DESIGN.md §6): a config file of version 1 (the demo's
`gcr-registry.json`) is refused, except to hand its factory over. The version 2 factory's config file is
`gcr-v2.json`, the default of `--config`.

## Files

| File | What | In the repository? |
|---|---|---|
| `chainintegrate.keystore.json` | ChainIntegrate's key: deploys the factory, creates registers; needs a little LYX | **Never** |
| `owner.keystore.json` | Only for an owner that uses a key file; needs no LYX | **Never** |
| `gcr-v2.json` (`gcr-registry.json` for version 1) | Network, factory (its version) and register addresses and blocks, which key files to use | No (it may name the company) |

All three are in `.gitignore`. Keep a copy of each key file and its password.

## A new supplier

```bash
# Once per network (done on LUKSO mainnet on 2026-11-17): ChainIntegrate's key (a little LYX), the
# factory (version 2 by default), its source on LUKSO's explorer (needs npm ci), then the factory to
# ChainIntegrate's Universal Profile for the operator page
node scripts/owner.js new-key chainintegrate.keystore.json
node scripts/owner.js deploy-factory --network lukso --config gcr-v2.json
FACTORY=<its address> npx hardhat run --network luksoMainnet scripts/verify-lukso.js
node scripts/owner.js transfer-factory 0x<ChainIntegrate's profile> --config gcr-v2.json

# Per supplier: from the operator page (see admin.md), since the factory belongs to the profile; from
# the command line only with a factory still owned by the key file:
node scripts/owner.js create-registry --network lukso --name "Argonia Gas Tecnici" --symbol ARGCYL \
  --owner 0x<the account's address> --config gcr-v2.json
```

`create-registry` creates the register **without its data key** (review X-02): no password is asked and
no recovery code is shown. The supplier makes both at the first sign-in in the admin page, and does
everything else from there. An owner using these tools with a key file (`--owner-keystore`) makes them
with `init-keys` instead: the data password twice, the 24-word recovery code shown once, two of its
words checked.

If the network does not answer while a register is being created, the tools look for it for five
minutes. If they still stop, check whether it exists before trying again (a new attempt makes a new
address), and save an existing one with `use-registry <address>`.

## Other commands

| Command | What |
|---|---|
| `status` | The register: name, owner, phones, cylinders, key wraps |
| `phone-setup` | The setup code and its QR in the terminal (the admin page shows the same) |
| `use-registry <address>` | Save a register created earlier into the config file |
| `transfer-factory <address>` | Hand the factory over to ChainIntegrate's Universal Profile, in one final step: the address must answer as a profile (LSP0), and you retype its last six characters |

For an owner with a key file (`--owner-keystore` at creation), the owner operations are here too:
`settings`, `counterparties`, `add-customer`, `add-refill-plant`, `edit-counterparty`,
`remove-counterparty`, `phones`, `add-phone`, `remove-phone`, `change-password [--recovery]`. Each is
signed with the owner's key file and sent through the relayer (`"relayer"` in the config file) or,
without one, by ChainIntegrate's key. The handover, its cancellation and acceptance, corrections, nonce
cancellations and the data key's replacement are in the tools' library (`scripts/lib/owner.js`:
`transferOwnership`, `cancelOwnershipTransfer`, `acceptOwnership`, `correctCylinder`, `cancelNonces`,
`applyDataKey` with `shared`'s `replaceDataKey`) and in the admin page; they have no command of their
own.

## Networks

`--network lukso` (default) uses `LUKSO_RPC_URL` or LUKSO's public node; `lukso-testnet` and `local`
exist for tests. If the public node is slow, set `LUKSO_RPC_URL` to ChainIntegrate's node for the
command.
