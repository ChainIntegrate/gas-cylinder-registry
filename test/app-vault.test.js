"use strict";
// What the app keeps on the phone, encrypted under a key derived from the data key (review A09).

const { expect } = require("chai");
const S = require("../shared");
const { Vault, seal, open } = require("../app/src/vault");

class MemoryStorage {
  constructor() {
    this.m = {};
  }
  getItem(k) {
    return k in this.m ? this.m[k] : null;
  }
  setItem(k, v) {
    this.m[k] = String(v);
  }
  removeItem(k) {
    delete this.m[k];
  }
}

describe("app vault", function () {
  const registry = "0x" + "11".repeat(20);
  let keys;
  before(async function () {
    keys = await S.deriveKeys(new Uint8Array(32).fill(9), registry);
  });

  it("seals values that open only with the key and under their own name", async function () {
    const v = await seal(keys.cacheKey, "gcr.lists", '{"cps":[{"name":"Officina Demo"}]}');
    expect(v.startsWith("gcrv1:")).to.equal(true);
    expect(v).to.not.include("Officina");
    expect(await open(keys.cacheKey, "gcr.lists", v)).to.include("Officina Demo");
    let err = null;
    try {
      await open(keys.cacheKey, "gcr.outbox.v1", v);
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    const other = await S.deriveKeys(new Uint8Array(32).fill(8), registry);
    err = null;
    try {
      await open(other.cacheKey, "gcr.lists", v);
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
  });

  it("keeps nothing readable on the phone, takes in an older version's plain items, and wipes", async function () {
    const storage = new MemoryStorage();
    storage.setItem("gcr.lists", '{"cps":[{"name":"Officina Demo","emails":["demo@example.com"]}]}'); // app 0.2.3
    const vault = new Vault(storage, ["gcr.outbox.v1", "gcr.lists", "gcr.draft"]);
    expect(vault.getItem("gcr.lists")).to.equal(null); // locked: nothing
    await vault.unlock(keys.cacheKey);
    expect(vault.getItem("gcr.lists")).to.include("Officina Demo");
    vault.setItem("gcr.outbox.v1", '[{"mail":{"to":["demo@example.com"]}}]');
    await vault.flush();
    expect(Object.keys(storage.m).sort()).to.deep.equal(["gcr.lists.sealed", "gcr.outbox.v1.sealed"]);
    expect(JSON.stringify(storage.m)).to.not.include("example.com");

    vault.lock();
    expect(vault.getItem("gcr.outbox.v1")).to.equal(null);
    let err = null;
    try {
      vault.setItem("gcr.lists", "x");
    } catch (e) {
      err = e;
    }
    expect(err && err.message).to.match(/locked/);

    const again = new Vault(storage, ["gcr.outbox.v1", "gcr.lists", "gcr.draft"]);
    await again.unlock(keys.cacheKey);
    expect(again.getItem("gcr.outbox.v1")).to.include("demo@example.com");
    again.wipe();
    expect(Object.keys(storage.m)).to.deep.equal([]);
  });
});
