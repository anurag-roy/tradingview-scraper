import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { parseConfigRows } from './config.js';

export function hasSheetConfig(env = process.env) {
  return Boolean((env.GOOGLE_SHEET_ID || env.GOOGLE_SHEET_URL || '').trim());
}

async function createSheetAccess(env, scope) {
  const raw = (env.GOOGLE_SHEET_ID || env.GOOGLE_SHEET_URL || '').trim();
  const spreadsheetId = raw.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] || raw;
  if (!/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) throw new Error('Set GOOGLE_SHEET_ID to the spreadsheet ID or Google Sheets URL.');
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
    scopes: [`https://www.googleapis.com/auth/${scope}`],
  });
  return { auth, spreadsheetId };
}

export async function createConfigReader(env = process.env) {
  const { auth, spreadsheetId } = await createSheetAccess(env, 'spreadsheets.readonly');
  const tab = (env.CONFIG_TAB || 'config').trim();
  if (!tab) throw new Error('CONFIG_TAB must not be blank.');
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

function sheetFailure(error) {
  // Keep raw Google errors (which can contain credentials) out of logs.
  const status = error.response?.status;
  const hint = status === 403 ? 'Enable the Sheets API and share the spreadsheet with the service account as Editor.'
    : status === 404 ? 'Check the sheet ID and service-account access.'
      : status === 400 ? 'Check that the data tab exists and column A is writable.' : undefined;
  return {
    status: Number.isInteger(status) && status >= 400 && status < 500 ? 'failed' : 'uncertain',
    ...(Number.isInteger(status) ? { httpStatus: status } : { reason: 'network-error-or-timeout' }),
    ...(hint ? { hint } : {}),
  };
}

/** Keep the current trading session's messages in A; never retry an append. */
export async function createSignalWriter(env = process.env) {
  const { auth, spreadsheetId } = await createSheetAccess(env, 'spreadsheets');
  const range = "'data'!A:A";
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const valuesUrl = `${baseUrl}/values/${encodeURIComponent(range)}`;
  return {
    async append(text) {
      try {
        const client = await auth.getClient();
        const response = await client.request({
          url: `${valuesUrl}:append`, method: 'POST',
          // Append after the existing column-A table without shifting other columns.
          params: { valueInputOption: 'RAW', insertDataOption: 'OVERWRITE' },
          data: { majorDimension: 'ROWS', values: [[text]] },
          timeout: 20_000, retry: false,
        });
        const updates = response.data?.updates;
        if (updates?.updatedCells === 1 && updates.updatedRows === 1 &&
          updates.updatedColumns === 1 && typeof updates.updatedRange === 'string') {
          return { status: 'written', updatedRange: updates.updatedRange };
        }
        return { status: 'uncertain', reason: 'unexpected-append-response' };
      } catch (error) { return sheetFailure(error); }
    },

    async keepSession(session) {
      try {
        const client = await auth.getClient();
        const response = await client.request({
          url: valuesUrl, method: 'GET',
          params: { majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE' },
          timeout: 20_000, retry: false,
        });
        const rows = response.data.values || [];
        if (!Array.isArray(rows)) return { status: 'uncertain', reason: 'unexpected-values-response' };
        const kept = rows.filter(row => {
          const match = typeof row[0] === 'string' && row[0].match(/ : (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) IST$/);
          const candleTime = match ? Date.parse(`${match[1]}T${match[2]}:00+05:30`) : NaN;
          return candleTime >= session.start && candleTime < session.end;
        });
        const removed = rows.filter(row => row[0] !== undefined && row[0] !== '').length - kept.length;
        if (kept.length !== rows.length) {
          const metadata = await client.request({
            url: baseUrl, method: 'GET', params: { fields: 'sheets.properties(sheetId,title)' },
            timeout: 20_000, retry: false,
          });
          const sheetId = metadata.data.sheets?.find(sheet => sheet.properties?.title === 'data')?.properties.sheetId;
          if (!Number.isInteger(sheetId)) return { status: 'failed', reason: 'data-tab-not-found' };
          // One atomic update retains current text and clears the unused tail.
          // Only A's values change; other columns and formatting stay intact.
          await client.request({
            url: `${baseUrl}:batchUpdate`, method: 'POST',
            data: { requests: [{ updateCells: {
              range: { sheetId, startRowIndex: 0, endRowIndex: rows.length, startColumnIndex: 0, endColumnIndex: 1 },
              rows: kept.map(row => ({ values: [{ userEnteredValue: { stringValue: row[0] } }] })),
              fields: 'userEnteredValue',
            } }] },
            timeout: 20_000, retry: false,
          });
        }
        return { status: 'pruned', removed, kept: kept.length };
      } catch (error) { return sheetFailure(error); }
    },
  };
}
