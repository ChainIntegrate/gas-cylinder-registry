# Owner tools (demo)

Command-line tools for what only a registry's owner does: create the registry, authorize the drivers'
phones, keep the list of customers and refill plants, change the data password. They run on a
computer with Node.js 20 or later, from this repository after `npm install`.

```bash
node scripts/owner.js help
```

During the demo the owner is an EOA held by ChainIntegrate. Every owner operation is **signed** with
the owner's key and **sent** by ChainIntegrate's key, which pays the gas, as the relayer will do: the
owner's key never needs LYX. A web page replaces these tools when owners move to a Universal Profile.

## Files

| File | What | Commit it? |
|---|---|---|
| `chainintegrate.keystore.json` | ChainIntegrate's key (deploys the factory, creates registries, sends operations); needs LYX | **Never** |
| `owner.keystore.json` | The registry owner's key; needs no LYX | **Never** |
| `gcr-registry.json` | Network, factory and registry addresses, and which key files to use | No (it may name the company) |

All three are in `.gitignore`. Keep a copy of each key file and its password: a lost key cannot be
recovered.

## Setting up the demo

```bash
# 1. Keys (once). Fund ChainIntegrate's address with a little LYX.
node scripts/owner.js new-key chainintegrate.keystore.json
node scripts/owner.js new-key owner.keystore.json

# 2. Factory (once per network)
node scripts/owner.js deploy-factory --network lukso

# 3. The company's registry: asks the data password, shows the 24-word recovery code once
node scripts/owner.js create-registry --name "Argonia Gas Tecnici cylinders" --symbol ARGCYL \
  --owner-keystore owner.keystore.json --language it

# 4. Customers, refill plants, phones
node scripts/owner.js add-customer --name "Officina Demo" --email demo@example.com
node scripts/owner.js add-customer --name "Cliente Due"
node scripts/owner.js add-phone "d59F 2E8B …"  # the code the app shows at its first start (spaces allowed)
node scripts/owner.js status
```

## Day to day

| Command | When |
|---|---|
| `counterparties` | See customers and refill plants with their ids |
| `add-customer`, `add-refill-plant` | A new customer or refill plant (`--name`, any number of `--email`) |
| `edit-counterparty <id>` | New name or e-mails (`--email` replaces the whole list) |
| `remove-counterparty <id>` | Hide it from the app's list; its past documents keep it |
| `phones`, `add-phone`, `remove-phone` | A new phone; a lost phone or a driver who leaves (revocation is enough) |
| `change-password` | A new data password, with the current one |
| `change-password --recovery` | The password is lost: the 24 words open the data key, then a new password is set |

Phones already set up keep working after a password change: they hold the data key, not the password.

## The data password and the recovery code

- The data password protects data that anyone can copy from the chain and attack offline forever:
  the tools accept a phrase of 20 or more characters, or 14 or more mixing letters, digits and symbols.
- The recovery code (24 words, English or Italian) is shown **once**, when the registry is created;
  the tools ask for two of its words before going on. Write it on paper and keep it in a safe place.
- Without both the password and the recovery code, the data can no longer be read by anyone,
  ChainIntegrate included.
