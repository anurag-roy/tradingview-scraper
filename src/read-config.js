import { createConfigReader } from './sheets.js';

try {
  const config = await (await createConfigReader()).read();
  console.log(JSON.stringify({
    instruments: config.instruments,
    warnings: config.warnings,
    loginCredentialsPresent: Boolean(config.credentials.username && config.credentials.password),
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
