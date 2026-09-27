# Udemy 課程下載助手

Chrome Manifest V3 擴充功能，適用於已登入且可正常播放的 Udemy 課程。v0.3.0 可檢查官方下載選項、備份單堂未加密 HLS 影片，或載入課程目錄後依章節批次備份影片。沒有綁定特定課程 ID。

## 安裝與更新

1. Chrome 網址列輸入 `chrome://extensions`。
2. 開啟右上角「開發人員模式」。
3. 按「載入未封裝項目」，選擇本專案中的 **`extension` 資料夾**（內含 `manifest.json`），不是專案根目錄。若使用 ZIP，請先解壓縮，再選擇包含 `manifest.json` 的資料夾。
4. 到 Udemy 開啟一堂影片，點工具列的擴充功能圖示，選「Udemy 課程下載助手」。

不需要 npm、Node.js、Python 或伺服器。原始碼可直接載入；ZIP 請先解壓縮。

**更新前先讓目前單堂下載完成。** 再到 `chrome://extensions`，在工具卡片按重新載入，關閉舊備份頁，回 Udemy 重新播放幾秒後暫停，再開啟新的工作。重新載入擴充功能會清除尚未取用的 session 工作資料；不要在下載中更新。

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

2026-09-28（台灣時間），使用者已在課程「C# ASP .Net 5 电商API实战: 掌握极致RESTful风格」的「课程导学」（lecture ID `22112428`、asset ID `27699688`）測試單堂下載。播放器官方下載按鈕停用；播放器使用 Shaka 與 HLS。使用者提供畫面顯示已下載 **22 / 130** 個片段，後續文字確認單堂功能可用。片段進度截圖本身不代表整片已完成或所有內容均已驗證。

**v0.3.0 批次功能目前只經人工資料與模擬介面／瀏覽器 API 測試，尚未在真實 Udemy 上跑完整門課。** 瀏覽器工具無法直接操作 `chrome-extension://` 介面；實際批次結果需由使用者執行確認。沒有確認這門課的關閉期限，也不能從播放器畫面證明業者惡意關閉課程。

## 權限與資料

- `activeTab`：點擊工具時取得目前分頁的暫時存取權。
- `scripting`：讀取頁面控制、目錄與播放器已載入的 HLS 資源，並在批次中操作所選講座；不使用隱藏課程 API。
- `storage`：本機保存最多 100 筆官方下載「已送出」紀錄及最近 5 門課各自最後一次的批次 metadata。短效單堂串流網址與新工作 metadata 暫存於 `storage.session`；開啟對應進度頁後移除，後續在頁面記憶體使用。不使用同步儲存，不保存 File System 存取 handle 作為自動恢復授權。未取用的 session 工作 10 分鐘後失效；擴充功能重新載入、更新或瀏覽器重啟也會清除 session。
- 選用 `https://*.udemy.com/*` 與 `https://*.udemycdn.com/*`：啟用串流或批次流程時才要求，用於操作課程頁、讀取清單及片段。可在 Chrome 擴充功能設定移除。
- 資料夾授權由 Chrome 的檔案選擇器取得，只在使用者選定的位置寫入。

不讀取或匯出密碼、Cookie、解密金鑰；媒體請求使用瀏覽器既有登入狀態。沒有外部伺服器、分析追蹤或廣告。拒絕非 Udemy 網域、HTTP 或含帳密網址。僅在擴充功能的 CSP 精確限制 Udemy／Udemy CDN HTTPS 網域時允許轉址，並再次驗證最終來源。串流網址不出現在匯出的檢查、批次報告或下載歷程中。

## 故障排除

- **目錄不完整或無法識別講座**：確認課程頁已顯示完整章節，關閉擋住目錄的彈窗，再重新載入目錄。不要把未識別項目當成已備份。
- **找不到 HLS 清單或等待播放器逾時**：到來源講座確認可播放；必要時手動播放幾秒後暫停，再重試。瀏覽器可能阻擋自動播放，或暫停背景分頁。
- **加密／DRM／不支援格式**：工具停止這堂影片的處理。可使用 Udemy App 離線觀看，或請講師提供下載版本。
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

無第三方程式庫或建置流程。測試涵蓋下載控制、課程與講座切換、網址邊界、HLS 解析及拒絕加密、CSP 轉址限制、檔案串流寫入、批次目錄與選取、檔案存在／權限錯誤、重複工作鎖定及中斷取消。測試使用人工資料；mock 通過不等於 Chrome 實際執行所有轉址限制，也不等於已完成真實整課備份。

v0.3.0：115 項自動測試通過，包含另一門課、不同語言與無編號標題的目錄案例，以及停止時取消尚未完成的講座切換。

## 官方參考

- [電腦下載條件](https://support.udemy.com/hc/en-us/articles/229231167-How-to-Download-Lectures-to-a-Computer-if-Enabled)與[講師開啟下載](https://support.udemy.com/hc/en-us/articles/360052936774-How-Instructors-Can-Enable-Course-Videos-For-Downloading-on-a-Computer)。
- [課程存取說明](https://support.udemy.com/hc/en-us/articles/229603708-Lifetime-access)：一般取消發布不應影響既有學員，終身存取仍有帳戶與授權條件。
- [Android 離線說明](https://support.udemy.com/hc/en-us/articles/115006973308-Downloading-courses-for-offline-viewing-on-the-Android-app)：App 離線檔案加密且限 App 使用，不等於通用影片備份。
- [聯繫 Udemy](https://support.udemy.com/hc/en-us/articles/21521030699287-How-to-contact-Udemy-Support)。
- [Chrome 選用權限](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)、[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。
- [Chrome 擴充功能 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[CSP 轉址來源比對](https://www.w3.org/TR/CSP3/#match-url-to-source-expression)、[Fetch 轉址流程](https://fetch.spec.whatwg.org/#http-redirect-fetch)。
- [Resource Timing](https://www.w3.org/TR/resource-timing/)、[RFC 8216 時間標記](https://www.rfc-editor.org/rfc/rfc8216#section-4.3.2.6)、[舊版 HLS 快取指示](https://datatracker.ietf.org/doc/html/draft-pantos-http-live-streaming-12#section-3.4.6)。
