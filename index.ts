import fs from "fs";

import YAML from "yaml";

const src = fs.readFileSync("signals.yml", { encoding: "utf-8" });
const signals = YAML.parse(src) as object;

export default signals;
