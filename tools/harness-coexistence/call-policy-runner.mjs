import { pathToFileURL } from 'node:url';
const pkg = await import(pathToFileURL(process.argv[2]));
const result = { refused: false, callbacks: 0, offered: 0, allows_call: null, code: null };
try {
  new pkg.ToolAuthorizer({ enabled: false, call: () => false });
} catch (error) {
  if (!(error instanceof pkg.HarnessError)) throw error;
  result.refused = true; result.code = error.code;
  result.native_error = { class: error.constructor.name, message: error.message };
}
console.log(JSON.stringify(result));
