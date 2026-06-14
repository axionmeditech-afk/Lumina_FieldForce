const fs = require('fs');
const path = "server/routes.ts";
let content = fs.readFileSync(path, "utf8");

content = content.replace(
  "const [rows] = await conn.query<any[]>(\"SELECT `value` FROM `lff_app_config` WHERE `key` = 'weekend_days' LIMIT 1\");",
  "const [rows] = await conn.query<any[]>(\"SELECT `value` FROM `nmy5_const` WHERE `name` = 'APP_WEEKEND_DAYS' LIMIT 1\");"
);

content = content.replace(
  "\"INSERT INTO `lff_app_config` (`key`, `value`) VALUES ('weekend_days', ?) ON DUPLICATE KEY UPDATE `value` = ?\",",
  "\"INSERT INTO `nmy5_const` (`name`, `entity`, `value`, `type`, `visible`) VALUES ('APP_WEEKEND_DAYS', 1, ?, 'chaine', 1) ON DUPLICATE KEY UPDATE `value` = ?\","
);

fs.writeFileSync(path, content, "utf8");
console.log("Weekend config patched");
