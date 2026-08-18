import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const publicPath = resolve(process.argv[2] || "activation_public_key.pem");
const privatePath = resolve(process.argv[3] || ".secrets/activation_private_key.pem");
const force = process.argv.includes("--force");
if (!force && (existsSync(publicPath) || existsSync(privatePath))) {
  throw new Error("Activation key files already exist. Refusing to rotate them without --force.");
}
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
mkdirSync(dirname(publicPath), { recursive: true });
mkdirSync(dirname(privatePath), { recursive: true });
writeFileSync(publicPath, publicKey, { mode: 0o644 });
writeFileSync(privatePath, privateKey, { mode: 0o600 });
const publicKeyDer = createPublicKey(publicKey).export({ type: "spki", format: "der" });
process.stdout.write(JSON.stringify({
  publicPath,
  privatePath,
  publicKeySha256: createHash("sha256").update(publicKeyDer).digest("hex").toUpperCase(),
  privateKeyPrinted: false,
}));
