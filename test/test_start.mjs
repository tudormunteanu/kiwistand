// @format
import test from "ava";
import esmock from "esmock";
import process from "process";

import { pipe } from "it-pipe";
import { toString } from "uint8arrays/to-string";
import { fromString } from "uint8arrays/from-string";

import { start } from "../src/index.mjs";

function randInt() {
  return Math.floor(Math.random() * 10000);
}

test.serial(
  "run as bootstrap node but without correct default port",
  async (t) => {
    await t.throwsAsync(async () => {
      process.env.PORT = "1234";
      process.env.BIND_ADDRESS_V4 = "127.0.0.1";
      process.env.IS_BOOTSTRAP_NODE = "true";
      process.env.USE_EPHEMERAL_ID = "false";
      await import(`../src/config.mjs?${randInt()}`);
    });
  }
);

test.serial("run as bootstrap node", async (t) => {
  process.env.PORT = "53462";
  process.env.BIND_ADDRESS_V4 = "127.0.0.1";
  process.env.IS_BOOTSTRAP_NODE = "true";
  process.env.USE_EPHEMERAL_ID = "false";
  const config = (await import(`../src/config.mjs?${randInt()}`)).default;
  const node = await start(config);
  await node.stop();
  t.pass();
});

test.serial("if nodes can be bootstrapped", async (t) => {
  let node1, node2;
  const message = await new Promise(async (resolve, reject) => {
    process.env.PORT = "53462";
    process.env.BIND_ADDRESS_V4 = "127.0.0.1";
    process.env.IS_BOOTSTRAP_NODE = "true";
    process.env.USE_EPHEMERAL_ID = "false";
    const config1 = (await import(`../src/config.mjs?${randInt()}`)).default;

    const nodeHandler1 = {};
    const connHandler1 = {};
    const protoHandler1 = {
      "/test/1.0.0": ({ stream }) => {
        pipe(stream.source, async function (source) {
          for await (const msg of source) {
            resolve(toString(msg.subarray()));
          }
        });
      },
    };

    node1 = await start(config1, nodeHandler1, connHandler1, protoHandler1);

    process.env.PORT = "0";
    process.env.BIND_ADDRESS_V4 = "127.0.0.1";
    process.env.IS_BOOTSTRAP_NODE = "false";
    process.env.USE_EPHEMERAL_ID = "true";
    const config2 = (await import(`../src/config.mjs?${randInt()}`)).default;

    const nodeHandler2 = {
      "peer:discovery": async (evt) => {
        const stream = await node2.dialProtocol(
          evt.detail.multiaddrs[0],
          "/test/1.0.0"
        );
        pipe([fromString("this is a message")], stream.sink);
      },
    };
    const connHandler2 = {};
    node2 = await start(config2, nodeHandler2, connHandler2);
  });
  t.is(message, "this is a message");
  await node1.stop();
  await node2.stop();
});