import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { parseConfigRows } from './config.js';

export function hasSheetConfig(env = process.env) {
  return Boolean((env.GOOGLE_SHEET_ID || env.GOOGLE_SHEET_URL || '').trim());
}

export async function createConfigReader(env = process.env) {
  const raw = (env.GOOGLE_SHEET_ID || env.GOOGLE_SHEET_URL || '').trim();
  const spreadsheetId = raw.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] || raw;
  if (!/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) throw new Error('Set GOOGLE_SHEET_ID to the spreadsheet ID or Google Sheets URL.');
  const tab = (env.CONFIG_TAB || 'config').trim();
  if (!tab) throw new Error('CONFIG_TAB must not be blank.');
  const source = (env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  let credentials;
  if (source) {
    try {
      credentials = JSON.parse(source.startsWith('{') ? source : await fs.readFile(path.resolve(source), 'utf8'));
    } catch {
      throw new Error('Cannot read Google service-account JSON. Check GOOGLE_SERVICE_ACCOUNT_JSON (JSON or file path).');
    }
  } else {
    credentials = { client_email: env.GOOGLE_CLIENT_EMAIL, private_key: env.GOOGLE_PRIVATE_KEY };
  }
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('Set GOOGLE_SERVICE_ACCOUNT_JSON, or GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY in .env.');
  }
  const auth = new GoogleAuth({
    credentials: { type: 'service_account', client_email: credentials.client_email, private_key: String(credentials.private_key).replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const range = `'${tab.replaceAll("'", "''")}'!A1:E8`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  return {
    async read() {
      let response;
      try {
        const client = await auth.getClient();
        response = await client.request({ url, method: 'GET', params: { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' }, timeout: 20_000, retry: false });
      } catch (error) {
        // Google errors can contain request headers, key material or response cells.
        const status = error.response?.status;
        const hint = status === 403 ? ' Enable the Sheets API and share the sheet with the service account as Viewer.'
          : status === 404 ? ' Check the sheet ID and service-account access.'
            : status === 400 ? ' Check CONFIG_TAB and that the tab has at least columns A–E and eight rows.' : '';
        throw new Error(`Google config read failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.${hint}`);
      }
      if (response.data.values !== undefined && !Array.isArray(response.data.values)) throw new Error('Unexpected Google Sheets values response.');
      return parseConfigRows(response.data.values || []);
    },
  };
}
