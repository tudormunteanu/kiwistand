// @format
import { env } from "process";
import { rm } from "fs/promises";

import test from "ava";
import { pipe } from "it-pipe";
import { pushable } from "it-pushable";
import { toString } from "uint8arrays/to-string";
import { fromString } from "uint8arrays/from-string";
import * as lp from "it-length-prefixed";
import all from "it-all";

import {
  deserialize,
  compare,
  initiate,
  fromWire,
  toWire,
} from "../src/sync.mjs";
import * as store from "../src/store.mjs";

test("syncing tries", async (t) => {
  env.DATA_DIR = "dbtestA";
  const trieA = await store.create();
  await trieA.put(Buffer.from("0100", "hex"), Buffer.from("A", "utf8"));
  await trieA.put(Buffer.from("0101", "hex"), Buffer.from("C", "utf8"));
  await trieA.put(Buffer.from("0200", "hex"), Buffer.from("D", "utf8"));

  const peerIdA = "A";
  const level = 0;
  const exclude = [];

  env.DATA_DIR = "dbtestB";
  const trieB = await store.create();
  t.notDeepEqual(trieA.root(), trieB.root());
  const root = trieB.root();
  trieB.checkpoint();
  t.true(trieB.hasCheckpoints());

  const sendMock = async (peerId, protocol, message) => {
    if (protocol === "/levels/1.0.0") {
      return await compare(trieB, message);
    } else if (protocol === "/leaves/1.0.0") {
      const missing = deserialize(message);
      for await (let { node, key } of missing) {
        await trieB.put(key, node.value());
      }
    }
  };

  await initiate(trieA, peerIdA, exclude, level, sendMock);

  await trieB.commit();
  t.false(trieA.hasCheckpoints());
  t.notDeepEqual(trieB.root(), root);
  t.deepEqual(trieA.root(), trieB.root());

  await rm("dbtestA", { recursive: true });
  await rm("dbtestB", { recursive: true });
});

test("serializing into wire", async (t) => {
  t.plan(1);
  const message = { hello: "world" };
  const sink = async (source) => {
    const messages = await all(source);
    const sMessages = await pipe(messages, lp.decode(), async (source) => {
      const [msg] = await all(source);
      const sActual = toString(msg.subarray());
      const actual = JSON.parse(sActual);
      t.deepEqual(actual, message);
    });
  };

  await toWire(message, sink);
});

test("serializing from wire", async (t) => {
  t.plan(1);
  const message = { hello: "world" };
  const source = pushable();

  const sMessage = JSON.stringify(message);
  const buf = fromString(sMessage);
  const stream = await pipe([buf], lp.encode());

  const actual = await fromWire(stream);
  t.deepEqual(actual, [message]);
});
