const fs = require("fs");
const path = require("path");

const builtEntry = path.resolve(__dirname, "server_dist", "index.js");

if (!fs.existsSync(builtEntry)) {
  console.error(
    "Missing build output at server_dist/index.js. Run `npm run build` before `npm start`."
  );
  process.exit(1);
}

require(builtEntry);
