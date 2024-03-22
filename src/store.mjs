// @format
import { env } from "process";
import { resolve } from "path";

import normalizeUrl from "normalize-url";
import { utils } from "ethers";
import {
  Trie,
  BranchNode,
  ExtensionNode,
  LeafNode,
  decodeNode,
} from "@ethereumjs/trie";
import rlp from "@ethereumjs/rlp";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { decode } from "cbor-x";
import { open } from "lmdb";
import { eligible } from "@attestate/delegator2";

import log from "./logger.mjs";
import LMDB from "./lmdb.mjs";
import { verify, ecrecover, toDigest } from "./id.mjs";
import { EIP712_MESSAGE } from "./constants.mjs";
import { elog } from "./utils.mjs";
import * as messages from "./topics/messages.mjs";
import { newWalk } from "./WalkController.mjs";
import { insertMessage } from "./cache.mjs";
import { triggerNotification } from "./subscriptions.mjs";

const maxReaders = 500;

export const upvotes = new Set();
export const commentCounts = new Map();

export function addComment(storyId) {
  const count = commentCounts.get(storyId) || 0;
  commentCounts.set(storyId, count + 1);
}
//
// TODO: This function would benefit from constraining operation only to
// markers of the type "amplify" as to not accidentially store other types of
// markers.
export function passes(marker) {
  const exists = upvotes.has(marker);
  if (!exists) {
    upvotes.add(marker);
  }
  return !exists;
}
export function cache(upvotes, comments) {
  log("Caching upvote ids of upvotes, this can take a minute...");
  for (const { identity, href, type } of upvotes) {
    const marker = upvoteID(identity, href, type);
    passes(marker);
  }
  for (const { href } of comments) {
    addComment(href);
  }
}

export async function create(options) {
  return await Trie.create({
    // TODO: Understand if this should this use "resolve"? The metadata db uses
    // resolve.
    db: new LMDB({ path: env.DATA_DIR, maxReaders }),
    useRootPersistence: true,
    // UPDATE 2023-11-03: Previously we had set "useNodePruning" to "true" as
    // it would delete non-reachable nodes in the db and hence clear up storage
    // space. However, when "useNodePruning" is true and a trie.put(key, value)
    // write happens at the same time as someone retrieving the trie's leaves,
    // then the leaves retrieval will fail if its branch had changes in its
    // pointers to other nodes. Hence, "useNodePruning" must be turned off as
    // it is immediately getting rid of older versions of a trie upon
    // restructuring triggered by trie.put. We now wrote a unit test that also
    // covers this scenario. Setting it to false may increase local database
    // size temporarily, however, it'll also guarantee concurrency and old
    // nodes could still be pruned occasionally (e.g. upon startup of the
    // node).
    useNodePruning: false,
    ...options,
  });
}

// NOTE: https://ethereum.github.io/execution-specs/diffs/frontier_homestead/trie/index.html#ethereum.frontier.trie.encode_internal_node
export function hash(node) {
  if (
    node instanceof BranchNode ||
    node instanceof LeafNode ||
    node instanceof ExtensionNode
  ) {
    const encoded = rlp.encode(node.raw());
    if (encoded.length < 32) return node.serialize();
    return Buffer.from(keccak256(encoded));
  } else {
    throw new Error("Must be BranchNode, LeafNode or ExtensionNode");
  }
}

// NOTE: Function not tested because we took it from the ethereumjs/trie code
// base.
export function nibblesToBuffer(arr) {
  const buf = Buffer.alloc(arr.length / 2);
  for (let i = 0; i < buf.length; i++) {
    let q = i * 2;
    buf[i] = (arr[q] << 4) + arr[++q];
  }
  return buf;
}

export function isEqual(buf1, buf2) {
  // NOTE: Ethereum doesn't hash nodes that are smaller than 32 bytes encoded,
  // so it formats them into an array of buffers. And in this case, it could be
  // that those data structures get compared to hashes. But we want to avoid
  // that at all costs and so we're throwing if we're ever coming across such.
  if (Array.isArray(buf1) || Array.isArray(buf2)) {
    throw new Error("Can only compare buffers");
  }
  if (Buffer.isBuffer(buf1) && Buffer.isBuffer(buf2)) {
    return Buffer.compare(buf1, buf2) === 0;
  }
  return false;
}

export async function lookup(trie, hash, key) {
  const result = {
    node: null,
    type: null,
  };
  // NOTE: We're serializing nodes smaller than 32 bytes as Ethereum does.
  // And so, we have to decode them here to do a proper database lookup.
  try {
    result.node = decodeNode(hash);
    // NOTE: We report every < 32 bytes long hash as "missing" because any node
    // will always be able to decode them straight from the hash.
    result.type = "missing";
    return result;
  } catch (err) {
    // noop, we'll just continue below.
  }

  // NOTE: There are several ways we can look for matches in the database.
  // But most important is that we differentiate between nodes that are
  // missing and nodes that are hash-mismatches. That is because in cases of
  // hash mismatches, we know that the local node has the same subtree
  // available and that we'll have to descend deeper into the tree until we
  // find missing nodes. Whereas for missing nodes, we're well-served by
  // requesting them from the paired node.
  try {
    result.node = await trie.lookupNode(hash);
    result.type = "match";
  } catch (err) {
    if (err.toString().includes("Missing node in DB")) {
      // TODO: The empty buffer as a key is not recognized or leads to results.
      const path = await trie.findPath(key);
      result.node = path.node;
      result.type = "mismatch";
    } else {
      log(`Throwing error for looking up: "${hash.toString()}"`);
      throw err;
    }
  }
  return result;
}

export async function compare(localTrie, remotes) {
  const match = [];
  const missing = [];
  const mismatch = [];
  for (let remoteNode of remotes) {
    // NOTE: In case the level:0 is being compared and we're having to deal
    // with the root node.
    if (remoteNode.level === 0 && isEqual(localTrie.root(), remoteNode.hash)) {
      match.push(remoteNode);
      break;
    }

    const { node, type } = await lookup(
      localTrie,
      remoteNode.hash,
      remoteNode.key,
    );
    if (type === "match" && node) {
      match.push(remoteNode);
    } else if (type === "mismatch" && node) {
      mismatch.push(remoteNode);
    } else {
      missing.push(remoteNode);
    }
  }
  return {
    missing,
    mismatch,
    match,
  };
}

export async function descend(trie, level, exclude = []) {
  const emptyRoot = Buffer.from(
    "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
    "hex",
  );
  if (level === 0 && isEqual(emptyRoot, trie.root())) {
    return [
      {
        level: 0,
        key: Buffer.alloc(0),
        hash: trie.root(),
        node: null,
      },
    ];
  }

  let nodes = [];
  const onFound = (_, node, key, walkController, currentLevel) => {
    const nodeHash = hash(node);
    // TODO: Would be better if this was a set where all the hashes are included
    // e.g. as strings? It seems very slow to look up something using find.
    const match = exclude.find((markedNode) => isEqual(markedNode, nodeHash));
    // NOTE: The idea of the "exclude" array is that it contains nodes that
    // have matched on the remote trie, and so we don't have to send them along
    // in a future comparison. Hence, if we have a match, we simply return.
    if (match) return;

    if (currentLevel === 0) {
      if (level !== 0 && node instanceof LeafNode) {
        const fragments = [key, node.key()].map(nibblesToBuffer);
        key = Buffer.concat(fragments);
      } else {
        key = nibblesToBuffer(key);
      }

      nodes.push({
        level,
        key,
        hash: nodeHash,
        node,
      });
    } else if (node instanceof BranchNode || node instanceof ExtensionNode) {
      currentLevel -= 1;
      walkController.allChildren(node, key, currentLevel);
    }
  };
  try {
    await newWalk(onFound, trie, trie.root(), level);
  } catch (err) {
    if (err.toString().includes("Missing node in DB")) {
      elog(err, "descend: Didn't find any nodes");
      return nodes;
    } else {
      throw err;
    }
  }
  return nodes;
}

// NOTE: We use `utils.getAddress` from ethers here to make sure we hash a
// canonical key into the database.
export function upvoteID(identity, link, type) {
  return `${utils.getAddress(identity)}|${normalizeUrl(link)}|${type}`;
}

export async function atomicPut(
  trie,
  message,
  identity,
  allowlist,
  delegations,
) {
  const marker = upvoteID(identity, message.href, message.type);
  const { canonical, index } = toDigest(message);
  log(
    `Attempting to store message with index "${index}" and message: "${JSON.stringify(
      message,
    )}"`,
  );

  if (message.type === "amplify") {
    const legit = await passes(marker);
    if (!legit) {
      const err = `Message with marker "${marker}" doesn't pass legitimacy criteria (duplicate). It was probably submitted and accepted before.`;
      log(err);
      throw new Error(err);
    }
  }

  try {
    await trie.put(Buffer.from(index, "hex"), canonical);
    try {
      const cacheEnabled = false;
      const enhancer = enhance(allowlist, delegations, cacheEnabled);
      const enhancedMessage = enhancer(message);
      insertMessage(enhancedMessage);
      await triggerNotification(enhancedMessage);
    } catch (err) {
      // NOTE: insertMessage is just a cache, so if this operation fails, we
      // want the protocol to continue to execute as normally.
      log(`Inserting message threw: ${JSON.stringify(message)}`);
    }
    // TODO: Remove and replace with SQLite implementation
    if (message.type === "comment") {
      addComment(message.href);
    }
  } catch (err) {
    if (message.type !== "amplify") {
      throw new Error(
        `atomicPut: putting to trie failed with error "${err.toString()}" for message "${JSON.stringify(
          message,
        )}"`,
      );
    }

    // NOTE: If trie.put crashes the program and upvotes.delete is hence not
    // rolled back, this is not a problem as "upvotes" is only a memory-stored
    // cached data structure that gets recomputed upon every restart of the
    // application.
    const result = upvotes.delete(marker);
    let reason = `trie.put failed with "${err.toString()}". Successfully rolled back constraint`;
    if (!result) {
      reason = `trie.put failed with "${err.toString()}". Tried to roll back constraint but failed`;
    }
    log(reason);
    throw new Error(reason);
  }
  log(`Stored message with index "${index}"`);
  log(`New root: "${trie.root().toString("hex")}"`);

  return {
    index,
    canonical,
  };
}

export async function add(
  trie,
  message,
  libp2p,
  allowlist,
  delegations,
  synching = false,
  metadb = upvotes,
) {
  const address = verify(message);
  const identity = eligible(allowlist, delegations, address);
  if (!identity) {
    const err = `Address "${address}" wasn't found in the allow list or delegations list. Dropping message "${JSON.stringify(
      message,
    )}".`;
    log(err);
    throw new Error("You must mint the Kiwi NFT to upvote and submit!");
  }

  const minTimestampSecs = parseInt(env.MIN_TIMESTAMP_SECS, 10);
  if (message.timestamp < minTimestampSecs) {
    const err = `Message timestamp is from before the year 2023 and so message is dropped: "${message.timestamp}"`;
    log(err);
    throw new Error(err);
  }

  const nowSecs = Date.now() / 1000;
  const toleranceSecs = parseInt(env.MAX_TIMESTAMP_DELTA_SECS, 10);
  const maxTimestampSecs = nowSecs + toleranceSecs;
  if (!synching && message.timestamp >= maxTimestampSecs) {
    const err = `Message timestamp is more than "${toleranceSecs}" seconds in the future and so message is dropped: "${message.timestamp}"`;
    log(err);
    throw new Error(err);
  }

  if (message.type === "comment") {
    let [_, hash] = message.href.split(":");
    if (!hash) {
      throw new Error("add: failed to extract hash from kiwi link");
    }
    hash = hash.substring(2);

    const parser = JSON.parse;

    let root;
    try {
      root = await leaf(trie, Buffer.from(hash, "hex"), parser);
    } catch (err) {
      throw new Error(`add: Didn't find root message of comment`);
    }

    if (root.timestamp >= message.timestamp) {
      throw new Error(
        "add: child timestamp must be greater than parent timestamp",
      );
    }
  }

  const { index, canonical } = await atomicPut(
    trie,
    message,
    identity,
    allowlist,
    delegations,
  );

  if (!libp2p) {
    log(
      "Didn't distribute message after ingestion because libp2p instance isn't defined",
    );
    return index;
  }

  log(`Sending message to peers: "${messages.name}" and index: "${index}"`);
  libp2p.pubsub.publish(messages.name, canonical);
  return index;
}

export async function leaf(trie, index, parser) {
  if (!(index instanceof Buffer)) {
    throw new Error("index parameter must be of type Buffer");
  }

  let node;
  const throwIfMissing = true;
  try {
    const path = await trie.findPath(index, throwIfMissing);
    node = path.node;
  } catch (err) {
    throw new Error(
      `Didn't find node for index ${index.toString(
        "hex",
      )}, "${err.toString()}"`,
    );
  }

  if (!node || !(node instanceof LeafNode)) {
    throw new Error(
      `Didn't find a node or found a node but it wasn't of type LeafNode for index "${index}"`,
    );
  }

  let message = decode(node.value());
  if (parser) {
    message = parser(message);
  }
  return message;
}

export async function post(trie, index, parser, allowlist, delegations) {
  const message = await leaf(trie, index, parser);
  const cacheEnabled = true;
  const signer = ecrecover(message, EIP712_MESSAGE, cacheEnabled);
  const identity = eligible(allowlist, delegations, signer);
  if (!identity) {
    throw new Error(`Identity not found: ${signer}`);
    return null;
  }

  let upvoters = [];
  let comments = [];
  if (parser) {
    const from = null;
    const amount = null;
    const startDatetime = null;
    const upvotes = await posts(
      trie,
      from,
      amount,
      parser,
      startDatetime,
      allowlist,
      delegations,
      message.href,
      "amplify",
    );
    upvoters = upvotes.map(({ identity, timestamp }) => ({
      identity,
      timestamp,
    }));

    comments = await posts(
      trie,
      from,
      amount,
      parser,
      startDatetime,
      allowlist,
      delegations,
      `kiwi:0x${index.toString("hex")}`,
      "comment",
    );
  }

  return {
    key: index.toString("hex"),
    value: {
      signer,
      identity,
      ...message,
      upvoters,
      upvotes: upvoters.length,
      comments,
    },
  };
}

// TODO: It'd be better to accept a JavaScript Date here and not expect a unix
// timestamp integer value.
export async function posts(
  trie,
  from,
  amount,
  parser,
  startDatetime,
  allowlist,
  delegations,
  href,
  type,
) {
  const nodes = await leaves(
    trie,
    from,
    amount,
    parser,
    startDatetime,
    href,
    type,
  );

  const cacheEnabled = true;
  const enhancer = enhance(allowlist, delegations, cacheEnabled);
  const posts = nodes.map(enhancer).filter((node) => node !== null);
  return posts;
}

export function enhance(allowlist, delegations, cacheEnabled) {
  return (node) => {
    const signer = ecrecover(node, EIP712_MESSAGE, cacheEnabled);
    const identity = eligible(allowlist, delegations, signer);
    if (!identity) {
      log(`Identity not found: ${signer}`);
      return null;
    }

    const { index } = toDigest(node);

    return {
      index,
      ...node,
      signer,
      identity,
    };
  };
}

export async function leaves(
  trie,
  from,
  amount,
  // TODO: Is passing the parser here still necessary?
  parser,
  startDatetime,
  href,
  type = "amplify",
  root = trie.root(),
) {
  if (type !== "amplify" && type !== "comment") {
    throw new Error(
      "store leaves: Must be called with type 'amplify' or 'comment'",
    );
  }
  const nodes = [];

  let pointer = 0;
  log(`leaves: Does trie have checkpoints? "${trie.hasCheckpoints()}"`);
  log(`leaves: Trie root "${root.toString("hex")}"`);
  for await (const [node] of walkTrieDfs(trie, root, [])) {
    if (Number.isInteger(amount) && nodes.length >= amount) {
      break;
    }

    const value = decode(node.value());
    if (parser) {
      const parsed = parser(value);

      if (type && type === parsed.type) {
        pointer++;
      }

      if (Number.isInteger(from) && pointer <= from) {
        continue;
      }

      if (parsed.timestamp < startDatetime) {
        continue;
      }
      if (
        (href && normalizeUrl(parsed.href) !== normalizeUrl(href)) ||
        (type && type !== parsed.type)
      ) {
        continue;
      }

      nodes.push(parsed);
    } else {
      pointer++;

      if (Number.isInteger(from) && pointer <= from) {
        continue;
      }

      nodes.push(value);
    }
  }

  return nodes;
}

/**
 * @param {Trie} trie
 * @param {Buffer | Buffer[]} nodeRef
 * @param {number[]} key
 */
async function* walkTrieDfs(trie, nodeRef, key) {
  if (
    // nodeRefs derived from BranchNode.getChildren can be arrays of buffers, but the root ref is always a single buffer
    Buffer.isBuffer(nodeRef) &&
    nodeRef.equals(trie.EMPTY_TRIE_ROOT)
  ) {
    return;
  }

  const node = await trie.lookupNode(nodeRef);

  if (node instanceof LeafNode) {
    yield [node, key];
    return;
  }

  if (node instanceof ExtensionNode) {
    const keyExtension = node.key();
    const childKey = key.concat(keyExtension);
    const childRef = node.value();
    yield* walkTrieDfs(trie, childRef, childKey);
  } else if (node instanceof BranchNode) {
    for (let i = 0; i < 16; i++) {
      const childRef = node.getBranch(i);
      if (childRef) {
        const childKey = key.concat([i]);
        yield* walkTrieDfs(trie, childRef, childKey);
      }
    }
  } else {
    throw new TypeError("Unknown node type");
  }
}
