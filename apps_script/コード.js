const BUCKET      = 'scout-system-pdf-intake-20250617';
const FOLDER_ID   = '1Qn6sJGsJVKhZdTGdPexieRELDJAkvdsf';     // jobs-inbox
const PROP        = PropertiesService.getScriptProperties(); // 処理済み管理

function pollJobsInbox() {
  const query = `'${FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`;
  const files = DriveApp.searchFiles(query);

  while (files.hasNext()) {
    const file = files.next();
    const id   = file.getId();
    if (PROP.getProperty(id)) continue;           // 既に処理済みならスキップ

    uploadToGCS_(file);
    PROP.setProperty(id, Date.now());             // 処理済みフラグ
  }
}

function uploadToGCS_(file) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`
            + `?uploadType=media&name=${encodeURIComponent(file.getName())}`;

  const resp = UrlFetchApp.fetch(url, {
    method      : 'post',
    contentType : 'application/pdf',
    payload     : file.getBlob().getBytes(),
    headers     : { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  /* ここから ↓ 追加 ------------- */
  const code = resp.getResponseCode();
  if (code !== 200) {
    Logger.log(`Upload error ${code}: ${resp.getContentText()}`);
    throw new Error('upload failed');   // ← トリガー実行でもログに残る
  }
  /* ここまで ↑ 追加 ------------- */
  
  Logger.log(`Upload ${file.getName()} → ${resp.getResponseCode()}`);
}
