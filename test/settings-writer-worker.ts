import { existsSync, writeFileSync } from "node:fs";
import { readPersistedSettings, writePersistedSettings } from "../src/settings-store.ts";

const [settingsPath, readyPath, goPath, section, key, jsonValue] = process.argv.slice(2);
if (!settingsPath || !readyPath || !goPath || !section || !key || jsonValue === undefined) process.exit(2);
const settings = readPersistedSettings(settingsPath);
(settings as any)[section][key] = JSON.parse(jsonValue);
writeFileSync(readyPath, "ready", "utf-8");
const waitArray = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goPath)) Atomics.wait(waitArray, 0, 0, 20);
writePersistedSettings(settings, settingsPath);
