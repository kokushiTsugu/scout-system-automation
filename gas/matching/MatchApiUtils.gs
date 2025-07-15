/**
 * fetchMatchApi(url, options)
 * ------------------------------------------------------------
 * - UrlFetchApp をラップし、Cloud Logging に
 *     {url, status, elapsed_ms, body(先頭500B)} を JSON 出力
 * - 2xx なら JSON.parse して返す
 * - それ以外は Error を throw（呼び出し側で try-catch して処理）
 * ------------------------------------------------------------
 * @param {string} url
 * @param {Object} options  UrlFetchApp のオプション
 * @return {Object}         パース済み JSON
 * @throws {Error}          非 2xx または JSON パース失敗
 */
function fetchMatchApi(url, options) {
  const t0 = Date.now();
  options  = { muteHttpExceptions: true, followRedirects: true, ...options };

  const res   = UrlFetchApp.fetch(url, options);
  const code  = res.getResponseCode();
  const body  = res.getContentText();
  const msec  = Date.now() - t0;

  console.log(JSON.stringify({
    url,
    status     : code,
    elapsed_ms : msec,
    body       : body.slice(0, 500)   // ログ肥大化防止
  }));

  if (code >= 200 && code < 300) {
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`Match API ${code}: JSON parse failed → ${e}`);
    }
  }

  throw new Error(`Match API ${code}: ${body}`);
}
