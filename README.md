# Udemy 課程下載助手

備份已登入且可正常播放的 Udemy 課程。提供 Chrome 擴充功能（v0.4.1）、Node.js CLI 與 Codex skill（v0.4.2），沒有綁定特定課程 ID。CLI 不需要安裝擴充功能；兩種介面共用目錄辨識、HLS 檢查與影片格式驗證。

## CLI

需要 Node.js 22.12+ 與正常開啟、已登入購課帳號的 Chrome 144+。安裝套件後即可執行，不需下載另一份瀏覽器：

```powershell
pnpm install --frozen-lockfile
node cli/index.mjs --help
node cli/index.mjs scan "https://www.udemy.com/course/your-course/learn/" --json
node cli/index.mjs download "https://www.udemy.com/course/your-course/learn/" --chapters 1,3 --max-height 1080 --out "D:\CourseBackups"
node cli/index.mjs download "https://www.udemy.com/course/your-course/learn/" --lectures 2,5 --out "D:\CourseBackups"
node cli/index.mjs download "https://www.udemy.com/course/your-course/learn/" --all --out "D:\CourseBackups"
```

也可使用 `npm install` 安裝 `package.json` 的套件。已知下載範圍可直接執行 `download`，它也會列出目錄，不必先跑一次 `scan`。

首次連線前，由使用者手動開啟 `chrome://inspect/#remote-debugging` 並啟用遠端偵錯。CLI 連線時會出現 Chrome 原生授權提示，使用者按「允許」後才繼續。這是 [Chrome 官方 auto-connect 流程](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)，透過 Puppeteer 官方連線介面定位本機 Chrome。CLI 不會修改設定、讀取 Chrome profile 中的登入資料檔案、接受自訂 CDP endpoint 或操作瀏覽器內部頁面。

CLI 只建立自己的課程分頁，沿用目前登入狀態。完成或取消時關閉本次分頁並中斷連線，保留使用者的其他分頁。若被導向登入頁，只等待使用者完成登入後返回指定課程，不讀取登入表單。

- `scan` 列出章節、全課講座編號與類型；全課編號包含文章、測驗等非影片項目。
- `--chapters` 選章節內的影片；`--lectures` 選全課講座編號；`--all` 選目前這門課的全部影片。三者擇一，未指定時只下載目前講座。
- `--quality best|worst` 預設最高畫質。`--max-height` 只接受不超過上限的已知高度；沒有符合版本或來源本身是無解析度資訊的單一 media 清單時，停止該堂。未指定上限時可保留未知解析度的來源串流。
- `--wait-login 600` 設定 Chrome 授權、課程及播放器的等待上限；不會無限重試。
- `--json` 讓 stdout 只輸出結果 JSON，進度寫到 stderr。退出碼 `0` 表示所選項目完成或略過、`1` 有失敗、`130` 使用者取消；略過不代表內容已驗證。

直接 HLS 也可使用 `download --media "<Udemy／Udemy CDN HTTPS HLS 網址>" --title "檔名" --out "資料夾"`。此模式不開 Chrome、不讀取 Cookie，不適用任意其他網站。

CLI 逐堂取得當次播放器已載入的清單，支援未加密且影音合併的 MPEG-TS HLS，輸出 `.ts`；不支援 DRM、解密、字幕、DASH 或分離音軌。Cookie 僅在本次程序記憶體使用，且只送到原課程的精確 Udemy origin；CDN 不帶這些 Cookie。所有 HTTP 轉址在送出下一個請求前都檢查 HTTPS 及 Udemy 網域。

影片完整寫入並關閉前，只存在隨機 `.part` 暫存檔；完成後以不覆寫的硬連結方式發布正式檔案，因此目的磁碟需支援硬連結（例如 NTFS、APFS、ext4）。既有非空檔會略過並標示未驗證；既有 0-byte 檔案會回報錯誤並保留，請指定其他輸出資料夾。Ctrl+C 會清理本次暫存檔，不刪除既有影片；沒有片段斷點續傳。

## Codex skill

```powershell
node scripts/install-skill.mjs
```

預設安裝到 `$CODEX_HOME/skills/udemy-course-backup`，未設定 `CODEX_HOME` 時使用 `~/.codex/skills/udemy-course-backup`。不會覆寫多奇使用的 `course-backup` skill。安裝後可用：

> 使用 $udemy-course-backup，列出這門 Udemy 的章節，下載第 1、3 章到 D:\CourseBackups。

更新同名 skill 時執行 `node scripts/install-skill.mjs --force`；專案搬家後也以此命令更新定位。或將 `UDEMY_BACKUP_HOME` 指向專案根目錄。`--dest` 可以指定技能資料夾本身。技能的 `scripts/run.mjs` 保留呼叫時的工作目錄，將參數交給本專案 CLI；`local-config.json` 只存在安裝位置，不提交版控。

CLI 與 skill 以模擬瀏覽器、合成 HLS 及本機檔案驗證；尚未以此 CLI 完成真實 Udemy 課程下載。原擴充功能的實測範圍見下方。

## 安裝與更新

1. Chrome 網址列輸入 `chrome://extensions`。
2. 開啟右上角「開發人員模式」。
3. 按「載入未封裝項目」，選擇本專案中的 **`extension` 資料夾**（內含 `manifest.json`），不是專案根目錄。若使用 ZIP，請先解壓縮，再選擇包含 `manifest.json` 的資料夾。
4. 到 Udemy 開啟一堂影片，點工具列的擴充功能圖示，選「Udemy 課程下載助手」。

擴充功能不需要 npm、Node.js、Python 或伺服器。原始碼可直接載入；ZIP 請先解壓縮。

**更新前先讓目前單堂下載完成。** 再到 `chrome://extensions`，在工具卡片按重新載入，關閉舊備份頁，回 Udemy 重新播放幾秒後暫停，再開啟新的工作。重新載入擴充功能會清除尚未取用的 session 工作資料；不要在下載中更新。

**v0.3.1 修正媒體保護狀態誤判：** 舊版只因 `video.mediaKeys` 非空就報 DRM，且可能讀到上一堂播放器殘留狀態。新版先核對目前講座、影片與新載入的 HLS 清單，再依清單及片段判斷加密。`mediaKeys` 只表示媒體元素已連接保護模組，不能單獨證明當前 HLS 已加密（[W3C EME 規格](https://w3c.github.io/encrypted-media/#dom-htmlmediaelement-setmediakeys)）。沒有找到清單時會保留「尚無法確認」的診斷；不會把它當成已證實 DRM，也沒有加入解密。更新後須**重新整理 Udemy 課程頁**，再重新建立批次工作，以清除先前注入的舊判定。

## 我的課程卡片標示

擴充功能 v0.4.1 可在 [Udemy 我的課程](https://www.udemy.com/home/my-courses/learning/) 的課程卡片顯示檢查結果，適用不同課程；支援一般課程網址及新版 `/course-dashboard-redirect/?course_id=…` 卡片連結。

1. 更新後先在 `chrome://extensions` 重新載入擴充功能，再重新整理「我的課程」頁。
2. 開啟擴充功能，按「啟用我的課程標示」，允許選用的 Udemy／Udemy CDN 網域讀取權限。
3. 在單張課程卡片按「抽查」或「逐堂檢查」；也可用頁面上方的「抽查本頁課程」或「逐堂檢查本頁」處理目前已載入的課程。
4. 新開的檢查頁會列出範圍，按「開始檢查」執行。可按「返回我的課程」查看卡片，標示會隨本次結果即時更新。

「抽查」只檢查每門課第一堂可辨識的影片，標示會註明只有部分講座已確認。「逐堂檢查」會依序檢查影片講座；只有完整目錄的所有影片都檢查完成，才會給整門課的可下載、不可下載或部分可下載結論。登入、網路、逾時、目錄不完整或來源證據不足時保留「尚未確認」，不把失敗當成整課不可下載。本頁操作只涵蓋當前頁面已載入的課程，若課程列表有分頁，請翻頁後另行檢查。

**這裡的「可下載」是目前工具的格式檢查結果：** 工具選取最高可用畫質，讀取 HLS 清單並驗證首個 MPEG-TS 片段；不儲存影片，也不代表已驗證全片、所有畫質或取得官方下載許可。「不可下載」表示檢查來源不符合目前工具的支援範圍。DASH 檢查只讀取 MPD 內容保護宣告來說明原因，不請求 license 或金鑰，也不進行 DRM 解密；僅觀察到 DASH 或 `mediaKeys` 不會直接判定 DRM。

檢查時會另外建立背景課程分頁，可能短暫靜音播放以取得來源，因此可能改變 Udemy 的最近觀看位置或進度。若 Chrome 延後啟動背景播放器，工具會將該檢查分頁短暫切到前景，每堂最多一次；取得來源後返回原分頁。如果你已手動切到其他分頁，工具不會把焦點拉回。請保持檢查頁開啟、Chrome 視窗可見，避免手動切換工具分頁的課程；完成、停止或關閉檢查頁時，工具會關閉自己建立的分頁。

「尚未確認」下方會直接顯示原因，例如目錄尚未載入、播放器未啟動、課程身分無法核對或媒體讀取失敗；「查看各堂結果」列出逐堂原因。v0.4.0 的舊紀錄沒有保留失敗階段，更新後需重新抽查才能取得新診斷。更新本機未封裝版本後，請重新載入擴充功能、重新整理「我的課程」，並從卡片開啟新的檢查工作。

結果只存在本機，保存課程／講座名稱、公有課程與講座識別碼、固定狀態及原因、檢查堂數與時間等摘要，不保存簽名媒體網址、Cookie、清單或金鑰。結果超過 24 小時會標示「需重新檢查」。可按「清除本頁標示」移除目前頁面課程的本機結果。

## 整門課批次備份

1. 在已登入的 Udemy 開啟要備份的課程播放器，從擴充功能按「載入整門課目錄」。
2. 在新的批次分頁按「授權並載入所有章節」，允許 Udemy／Udemy CDN 網域權限。工具會展開原課程分頁上的章節並讀取目錄；請保持來源分頁開啟。
3. 確認課程與目錄數量，選擇整門課、個別章節或講座及畫質。文章、測驗和無法確定類型的項目會列出，但不會自動選為影片。目錄不完整時不能開始，先回課程頁確認載入狀態，再重新載入目錄。
4. 按「選擇儲存資料夾」，選定位置後按「開始下載所選影片」。資料夾授權只需在這個批次頁操作一次；影片依課程／章節分目錄，檔名帶講次序號與 lecture ID。
5. 工具會依序切換所選講座，等待目前播放器與講座相符，再取得這堂新載入的 HLS 清單、檢查格式、下載並寫入檔案。每堂的串流網址都當場取得，不預先囤積整課的短效網址。
6. 保持 Chrome、來源課程分頁及批次分頁開啟，讓電腦保持喚醒。完成後查看每堂的結果，並開啟輸出影片抽查播放。

批次工作會操作來源課程分頁，期間不要在同一分頁自行切換講座、課程或重新整理。播放器取得清單後會暫停，但切換講座仍可能改變 Udemy 的最近觀看位置或進度。同一來源分頁或課程同時只能執行一個批次。

**停止與重試：** 可停止目前工作；在同一批次頁重新執行未完成及失敗的項目。這是從該堂影片重新下載，不是片段斷點續傳。已完成項目不必重跑。來源分頁被關閉、換到其他課程，或被 Chrome 暫停時，先按「查看課程分頁」確認狀態，再依畫面提示重試。

**同名檔案：** 既有非空檔會顯示「已有同名檔案（未驗證）」並跳過，工具不會把它認定為完整或可播放的影片。既有空檔允許重新寫入。取消或失敗後，新建立的位置可能留下空檔，可自行移除；工具不自動刪除檔案。

批次頁重新整理或關閉後不會自動還原執行中的工作。本機保留最近 5 門課各自最後一次的目錄與狀態 metadata，同一門課的新紀錄會替換舊紀錄；不保存媒體網址或可直接繼續的資料夾授權。本頁的「匯出進度紀錄」可匯出目前紀錄，目前沒有讀取先前報告的介面。需要重開工作時，從原課程重新載入目錄、選擇資料夾；既有非空檔仍會跳過。

## 單堂影片與官方下載

### 未加密 HLS 備份

1. 在課程頁播放幾秒後暫停，開啟擴充功能，按「檢查未加密串流備份」。
2. 確認新分頁顯示的講座名稱，再按「授權並檢查清單」。若有畫質選單，可選擇畫質後按「檢查此畫質」。
3. 檢查通過後按「選擇位置並開始儲存」。下載期間保持進度分頁開啟。
4. 等待「已完成儲存」後再開啟影片，檢查是否可正常播放。

### 官方下載與教材

按「檢查播放器選單」，辨識官方「下載講座」是否開放。若開放，按「下載」會觸發網站原有控制。教材請先在網頁展開「資源」選單，再按「重新檢查」。

「已送出」只是觸發網站操作，請到 Chrome 下載清單確認完成狀態。若頁面已切換講座或關閉選單，重新掃描後再操作。官方下載反灰時，工具不會強制啟用按鈕；批次影片功能也不會批次下載教材。

## 影片格式與支援範圍

支援同一串流中提供影音的、未加密 MPEG-TS HLS VOD。加密金鑰標記、DRM、獨立音軌、fMP4、位元組範圍、分段不連續或直播串流會停止處理。未宣告加密仍須通過每個片段的 MPEG-TS 格式檢查。其他播放器結構或 DASH 目前不支援；不同課程可能使用不同格式，不能保證每門課皆可備份。

輸出副檔名是 **`.ts`**，保留原始串流、不重新編碼。可用 VLC 等支援 MPEG-TS 的播放器觀看。`.ts` 不等於 `.mp4`，請勿直接改副檔名。如果電腦已有 FFmpeg，可轉封裝：

```powershell
ffmpeg -i 'lecture.ts' -map 0 -c copy 'lecture.mp4'
```

## 實際驗證範圍

v0.4.1 於 2026-09-29 使用正式目錄、播放器與抽查程式，透過 Chrome API 測試轉接層操作工具自建的真實 Udemy 分頁：重現背景播放器持續等待、沒有 HLS 清單；同一分頁切到可見前景後取得 HLS。接著在該課程頁以瀏覽器原有登入狀態、限定 Udemy 網域的 CSP 執行清單與首片段檢查，結果為 `hls-supported`。這驗證了一堂 HLS 的來源與首片段，沒有下載全片。自動恢復測試亦確認：Chrome 視窗仍隱藏時，選取分頁不足以開始播放；此情況保留未知並提示讓視窗可見。分頁建立、還原、取消競態及結果儲存以模擬 Chrome API 回歸測試；尚未在已安裝擴充功能中完成整門課抽查。

v0.4.0 已在真實「我的課程」DOM 預覽 12 張卡片標示與工具列，支援 `course-dashboard-redirect` 連結，並以播放頁 `course-taking` 的 `courseId` 核對卡片身分。預覽使用模擬的擴充功能儲存／訊息介面，沒有操作 Chrome 內部擴充功能頁。新版播放器探測器另已在一堂真實受保護 DASH 講座取得 MPD 並辨識內容保護宣告；HLS 來源辨識成功，但 CLI 實測的媒體請求未通過，因此維持「尚未確認」。HLS 正向分類、儲存更新、取消與權限邊界以合成資料及模擬瀏覽器測試；尚未以新擴充功能跑完整門課檢查。

另在一堂可正常 1080p 播放的講座觀察到 Udemy CDN 的 DASH MPD 與 fMP4 片段；實際 MPD 宣告 Common Encryption、Widevine、PlayReady，沒有觀察到 HLS 清單。此來源不在目前下載支援範圍。這次檢查沒有下載保存影片，也沒有讀取 license 或解密金鑰；結果僅適用那堂當時播放器的來源，不能推定整門課或其他課程都相同。

v0.3.2 增加來源格式摘要，批次錯誤診斷會顯示 HLS／DASH 觀察數量與播放器狀態，沒有媒體網址、query 或金鑰；DASH-only 觀察的逾時訊息會說明目前格式不支援。**這是診斷改良，沒有新增 DASH／DRM 下載能力。** 一般來源診斷只識別資源格式，不會僅因觀察到 MPD 就判定 DRM。

2026-09-28（台灣時間），使用者已在課程「C# ASP .Net 5 电商API实战: 掌握极致RESTful风格」的「课程导学」（lecture ID `22112428`、asset ID `27699688`）測試單堂下載。播放器官方下載按鈕停用；播放器使用 Shaka 與 HLS。使用者提供畫面顯示已下載 **22 / 130** 個片段，後續文字確認單堂功能可用。片段進度截圖本身不代表整片已完成或所有內容均已驗證。

**v0.3.0 批次功能目前只經人工資料與模擬介面／瀏覽器 API 測試，尚未在真實 Udemy 上跑完整門課。** 瀏覽器工具無法直接操作 `chrome-extension://` 介面；實際批次結果需由使用者執行確認。沒有確認這門課的關閉期限，也不能從播放器畫面證明業者惡意關閉課程。

## 權限與資料

- `activeTab`：點擊工具時取得目前分頁的暫時存取權。
- `scripting`：讀取頁面控制、目錄與播放器已載入的 HLS 資源，並在批次中操作所選講座；不使用隱藏課程 API。
- `storage`：本機保存最多 100 筆官方下載「已送出」紀錄、最近 5 門課各自最後一次的批次 metadata，以及課程卡片的檢查摘要。短效單堂串流網址與新工作 metadata 暫存於 `storage.session`；開啟對應進度頁後移除，後續在頁面記憶體使用。卡片檢查不把媒體網址寫入紀錄。不使用同步儲存，不保存 File System 存取 handle 作為自動恢復授權。未取用的單堂與批次 session 工作 10 分鐘後失效，卡片檢查工作 1 小時後失效；擴充功能重新載入、更新或瀏覽器重啟也會清除 session。
- 選用 `https://*.udemy.com/*` 與 `https://*.udemycdn.com/*`：啟用卡片標示、串流或批次流程時才要求，用於操作課程頁、讀取清單及片段。卡片標示啟用後，會在「我的課程」頁載入本機標示控制項。可在 Chrome 擴充功能設定移除權限。
- 資料夾授權由 Chrome 的檔案選擇器取得，只在使用者選定的位置寫入。

擴充功能不讀取或匯出密碼、Cookie、解密金鑰；媒體請求使用瀏覽器既有登入狀態。沒有外部伺服器、分析追蹤或廣告。拒絕非 Udemy 網域、HTTP 或含帳密網址。僅在擴充功能的 CSP 精確限制 Udemy／Udemy CDN HTTPS 網域時允許轉址，並再次驗證最終來源。串流網址不出現在匯出的檢查、批次報告或下載歷程中。CLI 的 Cookie 使用與逐次轉址檢查見上方 CLI 說明。

## 故障排除

- **目錄不完整或無法識別講座**：確認課程頁已顯示完整章節，關閉擋住目錄的彈窗，再重新載入目錄。不要把未識別項目當成已備份。
- **找不到 HLS 清單或等待播放器逾時**：到來源講座確認可播放；必要時手動播放幾秒後暫停，再重試。瀏覽器可能阻擋自動播放，或暫停背景分頁。
- **課程卡片抽查都顯示尚未確認**：更新到 v0.4.1、重新載入擴充功能並重新整理「我的課程」後，開啟新的抽查工作。抽查時保持 Chrome 視窗可見，工具會在必要時短暫顯示自己的課程分頁，讓播放器取得來源。仍失敗時查看卡片下方原因與「查看各堂結果」；不再把目錄、分頁、播放器和網路失敗全部歸成同一句訊息。Chrome 對隱藏分頁延後開始播放的行為見[官方說明](https://developer.chrome.com/blog/play-returns-promise)。
- **加密／DRM／不支援格式**：工具停止這堂影片的處理。可使用 Udemy App 離線觀看，或請講師提供下載版本。
- **舊版顯示「播放器使用受保護的媒體金鑰」**：這只是播放器狀態，尚未證實實際 HLS 已加密。更新到 v0.3.1、重新載入擴充功能並重新整理課程頁後，先用一堂重新檢查；真正加密的清單或片段仍不支援。
- **不支援的 HLS 標記**：回報畫面列出的標記名稱即可，不需要提供完整清單、Cookie 或含權杖網址。`EXT-X-ALLOW-CACHE:YES` 與 `EXT-X-PROGRAM-DATE-TIME` 已支援，`ALLOW-CACHE:NO` 仍停止。
- **401／403／過期**：回來源課程確認登入與播放狀態後重試；不偽造登入或繞過拒絕。
- **權限或網路錯誤**：畫面會標示失敗階段。單堂頁可按「複製錯誤診斷」回報；診斷只包含版本、階段、hostname、HTTP 狀態、權限布林值及片段編號，不含完整 URL、query、Cookie 或任意堆疊。若有 `cspBlockedHost`，表示來源被網域限制擋下，不會自動放寬。
- **資料夾授權取消／失效或磁碟空間不足**：重新選擇可寫入且空間足夠的位置，再重試未完成項目。權限問題不會被誤當成檔案不存在。
- **取消或失敗**：中止當堂寫入，不將部分影片標為完成；可能留下可自行刪除的空檔。批次既有非空檔不覆寫。
- **重新整理進度頁**：請從課程頁重新啟動；最近批次報告不是自動續傳狀態。

## 開發驗證

```powershell
node --test tests/*.test.mjs
```

擴充功能無第三方程式庫或建置流程；CLI 使用鎖定版本的 `puppeteer-core` 連接 Chrome。測試涵蓋下載控制、課程與講座切換、網址邊界、HLS 解析及拒絕加密、CSP 轉址限制、檔案串流寫入、批次目錄與選取、檔案存在／權限錯誤、重複工作鎖定及中斷取消。測試使用人工資料；mock 通過不等於 Chrome 實際執行所有轉址限制，也不等於已完成真實整課備份。

v0.3.0：115 項自動測試通過，包含另一門課、不同語言與無編號標題的目錄案例，以及停止時取消尚未完成的講座切換。

CLI v0.4.0：增加 CLI 參數、純 JSON 輸出、Chrome 連線生命週期、Cookie 來源限制、逐次轉址檢查、原子檔案發布與 skill 安裝器測試；測試不會開啟真實 Chrome 或下載課程影片。

## 官方參考

- [電腦下載條件](https://support.udemy.com/hc/en-us/articles/229231167-How-to-Download-Lectures-to-a-Computer-if-Enabled)與[講師開啟下載](https://support.udemy.com/hc/en-us/articles/360052936774-How-Instructors-Can-Enable-Course-Videos-For-Downloading-on-a-Computer)。
- [課程存取說明](https://support.udemy.com/hc/en-us/articles/229603708-Lifetime-access)：一般取消發布不應影響既有學員，終身存取仍有帳戶與授權條件。
- [Android 離線說明](https://support.udemy.com/hc/en-us/articles/115006973308-Downloading-courses-for-offline-viewing-on-the-Android-app)：App 離線檔案加密且限 App 使用，不等於通用影片備份。
- [聯繫 Udemy](https://support.udemy.com/hc/en-us/articles/21521030699287-How-to-contact-Udemy-Support)。
- [Chrome 選用權限](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)、[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。
- [Chrome 擴充功能 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[CSP 轉址來源比對](https://www.w3.org/TR/CSP3/#match-url-to-source-expression)、[Fetch 轉址流程](https://fetch.spec.whatwg.org/#http-redirect-fetch)。
- [Resource Timing](https://www.w3.org/TR/resource-timing/)、[RFC 8216 時間標記](https://www.rfc-editor.org/rfc/rfc8216#section-4.3.2.6)、[舊版 HLS 快取指示](https://datatracker.ietf.org/doc/html/draft-pantos-http-live-streaming-12#section-3.4.6)。
