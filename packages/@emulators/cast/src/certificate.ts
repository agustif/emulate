import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A throwaway certificate for the device to present.
 *
 * Real Cast devices present a self-signed chain and senders are expected not to
 * verify it, so any certificate at all will do. It exists only because TLS
 * insists on one.
 *
 * openssl rather than a library: it is present on macOS, on Linux, and on every
 * CI image this would run on, and Node can parse X.509 but not issue it.
 * Generated per process rather than committed — a private key in a repository
 * is a bad habit even when the key protects nothing.
 */
export async function selfSignedCertificate(): Promise<{ key: string; cert: string }> {
  const directory = await mkdtemp(join(tmpdir(), "emulate-cast-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");

  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=emulated-cast-device",
    ]);
  } catch (cause) {
    throw new Error(
      `the Cast device needs openssl to make a certificate for its TLS listener: ${String(cause)}`,
    );
  }

  const [key, cert] = await Promise.all([
    readFile(keyPath, "utf8"),
    readFile(certPath, "utf8"),
  ]);
  return { key, cert };
}
