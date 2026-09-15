#!/usr/bin/env node

/**
 * Node client for the registry. Writes and reads are deliberately asymmetric.
 *
 * Every write shells out to harness_registry.py, which owns the OS locking that
 * serializes an identity, so there is exactly one implementation of the write
 * rules. Reads are implemented here instead, because the adapter reads the
 * registry on every poll and a Python process per read would be the dominant
 * cost of serving a snapshot. This is not duplication to be collapsed: the two
 * paths are different operations with different contention.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";

export const REGISTRY_SCHEMA = "ocw-harness-registry-1";
export const REGISTRATION_SCHEMA = "ocw-harness-registration-1";

export function defaultRegistryDir() {
  if (process.env.OCW_HARNESS_REGISTRY_DIR) {
    return resolve(process.env.OCW_HARNESS_REGISTRY_DIR);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "OCW Harness", "registry");
  }
  return join(homedir(), ".ocw-harness", "registry");
}

function requireIdentifier(value, field) {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${field} must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  return value;
}

const runFile = promisify(execFile);
const writer = fileURLToPath(new URL("./harness_registry.py", import.meta.url));

async function writeRegistry(command, flags) {
  const args = [writer, command];
  for (const [name, value] of Object.entries(flags)) {
    if (value == null || value === false) continue;
    args.push(`--${name}`);
    if (value !== true) args.push(String(value));
  }
  try {
    const { stdout } = await runFile(process.env.OCW_PYTHON || "python3", args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message);
  }
}

export async function registerHarness(options) {
  return writeRegistry("register", {
    registry: options.registryDir || defaultRegistryDir(), source: options.source,
    session: options.sessionId, label: options.label, id: options.registrationId,
    pid: options.processId, instance: options.instanceId, "new-instance": options.newInstance,
  });
}

export async function updateRegistration(registrationId, updates, registryDir = defaultRegistryDir()) {
  const { instanceId, ...changes } = updates;
  return writeRegistry("update", { registry: registryDir, id: registrationId, instance: instanceId, updates: JSON.stringify(changes) });
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

export async function listRegistrations(registryDir = defaultRegistryDir()) {
  const directory = resolve(registryDir);
  const names = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const registrations = [];
  const errors = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const path = join(directory, name);
    try {
      const registration = await readJson(path);
      if (registration.schemaVersion !== REGISTRATION_SCHEMA) {
        throw new Error(`unsupported schema ${registration.schemaVersion || "missing"}`);
      }
      requireIdentifier(registration.registrationId, "registration id");
      registrations.push(registration);
    } catch (error) {
      errors.push({ file: name, message: error.message });
    }
  }
  return { schemaVersion: REGISTRY_SCHEMA, registryDir: directory, registrations, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFile(process.env.OCW_PYTHON || "python3", [writer, ...process.argv.slice(2)], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
    .then(({ stdout }) => process.stdout.write(stdout))
    .catch((error) => { process.stderr.write(error.stderr || `${error.message}\n`); process.exitCode = 1; });
}
