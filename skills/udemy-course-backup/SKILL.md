---
name: udemy-course-backup
description: 使用 Node.js CLI 備份使用者已購買且可正常播放的 Udemy 課程影片，列出目錄、選取章節或講座，或保存授權的 Udemy HLS 網址。不處理 Duotify、任意網站、字幕、DRM 解密或影片發布。
---

# Udemy 課程備份

透過本技能的 `scripts/run.mjs` 執行專案 CLI。先用 `node "<本技能絕對路徑>/scripts/run.mjs" --help` 確認目前選項。包裝程式依序使用 `UDEMY_BACKUP_HOME`、安裝時產生的 `local-config.json`，或技能所在儲存庫尋找 `cli/index.mjs`。專案搬家時，從新位置執行 `node scripts/install-skill.mjs --force` 更新本機設定；此技能與 Duotify 的 `course-backup` 分開安裝。

## 選擇範圍與執行

沿用使用者已指定的網址、儲存位置及範圍。已知要下載哪些章節或講座時直接執行，不為驗證而額外連接瀏覽器；使用者要求先列目錄確認時，仍先 `scan` 並依要求等待確認。範圍不明時先 `scan` 列出目錄，不能自行推定要整門課或整個帳號。使用者只要目前網址的講座時，`download` 不加範圍參數即可；CLI 預設僅處理目前講座。

```text
node "<技能路徑>/scripts/run.mjs" scan "<Udemy 課程播放器網址>" --json
node "<技能路徑>/scripts/run.mjs" download "<Udemy 講座網址>" --out "<輸出資料夾>"
node "<技能路徑>/scripts/run.mjs" download "<Udemy 課程播放器網址>" --out "<輸出資料夾>" --chapters 1,3 --quality best
node "<技能路徑>/scripts/run.mjs" download "<Udemy 課程播放器網址>" --out "<輸出資料夾>" --lectures 1,3 --max-height 1080
node "<技能路徑>/scripts/run.mjs" download "<Udemy 課程播放器網址>" --out "<輸出資料夾>" --all --quality worst
node "<技能路徑>/scripts/run.mjs" download --media "<授權的 HTTPS Udemy HLS 網址>" --title "<影片名稱>" --out "<輸出資料夾>"
```

`--chapters`、`--lectures`、`--all` 擇一使用；數字依 CLI 列出的 1 起算編號，不拿 lecture ID 代替選取編號。`--lectures` 使用全課編號，計數包含非影片項目，不能只對影片重新編號。`--quality` 接受 `best` 或 `worst`。`--max-height 1080` 只接受不超過上限且高度已知的版本；沒有符合版本或直接媒體清單缺少解析度資訊時停止，不改抓較高或未知畫質。使用者指定硬性畫質上限時不能移除這個限制重試。相對 `--out` 路徑以執行命令的工作目錄為準，包裝程式不改到專案目錄。

課程命令預設 `--browser existing`，透過 Chrome 144+ 的原生 auto-connect 授權連接已登入的正常 Chrome。不需要先安裝擴充功能。首次設定需要使用者自行開啟 `chrome://inspect/#remote-debugging` 啟用遠端偵錯，CLI 連線時由使用者接受 Chrome 原生允許提示；已完成的設定不重複要求。`--wait-login 600` 調整連線授權與登入等待秒數。不要要求使用者貼帳密、Cookie 或完整 Chrome profile。

Chrome 設定及連線提示須由使用者操作。若需要這兩步，說明原因並附上 [Chrome 官方 auto-connect 說明](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)。瀏覽器工具不允許操作的 `chrome://` 或 `chrome-extension://` 頁面，不能換成 CLI、CDP 或其他工具繞過限制。CLI 只操作自己建立的 Udemy 課程分頁，結束或取消時保留使用者既有瀏覽器及分頁。

直接 `--media` 模式只接受 HTTPS Udemy／Udemy CDN 的 HLS，不開啟瀏覽器、不帶登入 Cookie，不適用任意網站或需要另行取得登入資料的網址。不要把簽名媒體網址寫進報告、版控或長期記錄。

## 完成與失敗判定

- 程序仍在執行時，用工具回傳的 session 持續追蹤，不重複啟動同一工作。遇到明確錯誤先修正原因再重試，不反覆登入或無限重試存取拒絕。
- 結束碼 `0` 表示命令成功、`1` 表示失敗、`130` 表示取消。`scan --json` 的 stdout 供解析；狀態或錯誤由 stderr 接收，不把失敗輸出當成目錄。
- 依 CLI 的逐項結果判斷完成。既有非空檔被略過不等於已驗證完成；既有 0 位元組檔會保留並回報錯誤，不覆寫或刪除它來重試。下載使用自己建立的 `.part` 暫存，失敗或取消只清理本次暫存。取消或錯誤的項目不能列為成功。
- 完成後回報實際產生的絕對檔案路徑與大小，並用可用的本機媒體工具檢查影音及長度；沒有驗證播放時明確說明。合成測試通過不代表真實課程已下載或可完整離線播放。

支援已授權且正常可播放、影音合併的未加密 MPEG-TS HLS VOD，輸出 `.ts`。不支援字幕、DRM、擷取解密金鑰、獨立音軌合併、fMP4 或 DASH。遇到受保護或不支援格式時回報是哪一講座及原因，不尋找替代金鑰或繞過方式。課程模式只在記憶體使用同源登入 Cookie，不匯出 Cookie 或金鑰；錯誤回報不包含原始回應、簽名 URL 或含權杖的 debug 記錄。
