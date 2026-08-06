# <img src="TL_DR/assets/tldr.png" width="5%" />  TL;DR     
                           
TL;DR is a Chrome extension that reads how you read. It uses your webcam to track your eye movements in real time, analyses those movements every 2.5 seconds to determine your cognitive state, and automatically delivers AI-generated assistance — summaries, explanations, or simplifications — for the exact paragraph you are struggling with.  
      
Unlike a traditional AI assistant that waits for you to ask for help, TL;DR detects when you need it and acts before you consciously decide to ask. 
 
---   
 
## How it works

The extension runs three systems simultaneously.

The first is a gaze tracking layer built on WebGazer.js, which uses your laptop or desktop webcam to estimate where on the screen your eyes are pointing. Raw gaze coordinates are smoothed using an exponential moving average, filtered for velocity spikes, and passed through a DBSCAN noise filter that discards spatially isolated outlier points before any features are computed.

The second is a cognitive state classifier. Every 3 seconds, nine statistical features are computed from a 2.5-second rolling window of gaze data: average fixation duration, fixation stability, regression rate, saccade length, saccade consistency, gaze drift, scroll delta, gaze velocity, and line re-read count. Before classification, the features are normalised against the user's personal reading baseline and patched for the page's script — regression rate is inverted on right-to-left pages (Arabic, Hebrew) and fixation durations are scaled on CJK pages, where longer fixations are normal rather than a sign of confusion. The adjusted features are fed into a Decision Tree classifier trained on a synthetic dataset of 4,000 labelled gaze samples. The tree — exported as plain JavaScript if/else code — runs in under one millisecond and returns one of five cognitive state labels: focused, skimming, confused, zoning out, or overloaded.

The third is an AI response layer. When the classifier detects confusion or overload, the extension identifies the paragraph currently under the user's gaze, sends its text to a local Node.js server, and receives a Groq-generated response. Confused readers receive a deeper explanation of the paragraph. Overloaded readers receive a simplified rewrite. Zoning out triggers a visual highlight on the current paragraph with no AI call. Focused and skimming states produce no action. Responses always come back in the same language as the text being read, and repeat requests for the same paragraph are served instantly from a session cache.

Text selection also works independently of eye tracking. Selecting any text on any page triggers an AI summary popup immediately. Images get the same treatment: gazing at a figure for two seconds while confused — or Ctrl-hovering over any image — triggers an AI explanation of what the image shows and how it relates to the surrounding text.

Beyond the core loop, the extension ships a comprehension monitor (flags dense paragraphs read too fast, or silent struggle read far below personal baseline), reading personas (one-click presets for research, study, casual, and speed reading), a collapsible reading map sidebar with progress and confusion events, dark mode across all UI, text-to-speech with word-level highlighting, a dyslexia mode with adapted fonts and softened classifier thresholds, and viewers for local PDF and PPTX files. The full feature reference is in [TL_DR/README.md](TL_DR/README.md).

---

## Architecture

The extension runs across three separate JavaScript execution environments, which is the central architectural constraint the codebase is built around.

The page context is where WebGazer runs. It has access to the DOM and global variables like `window.webgazer`, but cannot call any Chrome extension APIs. The content script isolated world is where all extension logic runs. It can call `chrome.runtime`, `chrome.storage`, and use dynamic `import()` to load extension modules, but it cannot access the page's global variables. The background service worker handles privileged operations like saving notes and fallback script injection, but has no DOM access at all.

Because these environments cannot call each other's functions directly, the codebase uses `window.postMessage` as the communication channel. `webgazer-bootstrap.js` runs in the page context, catches WebGazer's gaze callbacks, and forwards them to the content script via postMessage. The content script listens for these messages and processes the coordinates. The calibration flow uses the same channel in reverse: the content script sends click coordinates via postMessage to the bootstrap, which calls `webgazer.recordScreenPosition()` — a function that only exists in page context.

The backend server exists because the Groq API key cannot be stored in the extension, where it would be readable by anyone who inspects the extension files. The server is a thin Express proxy: it receives the paragraph text and mode from the extension, builds the appropriate prompt, calls the Groq API, and returns the response. Nothing is stored server-side.

---

## Cognitive states

**Focused** — steady fixations in the 150 to 350ms range, low regression rate, consistent forward saccades, gradual scroll. No action taken.

**Skimming** — short fixations under 150ms, large saccade jumps, fast scroll. Deliberate behaviour that should not be interrupted.

**Confused** — fixations above 350ms, regression rate above 20%, short choppy saccades, near-zero scroll. The classifier triggers a Groq explanation of the current paragraph.

**Zoning out** — very long fixations above 600ms, high gaze drift off the text baseline, zero scroll. The current paragraph receives a pulsing highlight to draw attention back. No AI call is made.

**Overloaded** — very high regression rate above 30%, extremely short saccades, very high line re-read count, near-zero scroll. The classifier triggers a Groq simplification of the current paragraph.

---

## The classifier

The Decision Tree was trained on a synthetic dataset generated from distributions derived from published reading research, primarily Rayner (1998), Just and Carpenter (1980), and Siegenthaler et al. (2011). Synthetic data was necessary because no public labelled gaze dataset exists for reading cognitive states.

The dataset contains 2,500 rows across five classes, 500 per class. Each row represents 9 gaze features computed over a 2.5-second window. Every row is then duplicated with Gaussian noise added to each feature, giving 5,000 rows in total. The tree is trained with a maximum depth of 7, a minimum leaf size, and balanced class weights, on 4,000 of those rows with the remaining 1,000 held out.

After training, the tree is exported from sklearn as a JavaScript function containing plain if/else conditions. This function runs in the browser without any machine learning library, with no external dependencies, in under one millisecond per classification.

The notebook that produced the tree currently shipping is `tldr classifier/tldr_classifier_training(1).ipynb`. Running all cells regenerates the dataset CSV, trains the model, produces evaluation charts, and exports a new `classifier.js`. A second notebook, `tldr_classifier_v2.ipynb`, exports a different tree that is not the one in the extension.

### On accuracy

**No real-participant evaluation of this classifier has been performed, and no accuracy figure for it should be treated as meaningful.**

The training data is synthetic throughout — hand-written normal distributions, not recordings of anyone reading. A test score against a held-out slice of that data measures how well the tree recovers the rules of the generator that produced its own training set. It does not measure reading. The score is also inflated by construction: the noise-augmented copies are perturbed duplicates of the clean rows and the train/test split is random, so a row's own noisy twin can land in the test set while the original sits in training.

The figure recorded in the header of `src/content/classifier.js` is kept there for provenance, with that context attached. It is not a claim about how well this extension detects anything. Earlier drafts of this README carried an 88% test figure and a "75 to 82% real-world" estimate; both have been removed. The second was never measured against anything at all.

Establishing an honest number means running the pipeline against real gaze data with comprehension outcomes — the WebQAmGaze and OneStop corpora are the obvious starting points — and then against real participants. None of that has been done yet.

---

## Eye tracking accuracy

Consumer webcam eye tracking achieves approximately 80 to 200 pixels of residual error after calibration. This is sufficient to identify which paragraph a reader is on, but not which specific word. The classifier operates at paragraph granularity, which matches this accuracy level.

The debug mode toggle in the extension popup shows WebGazer's raw prediction dot on screen. The shakiness of this dot is expected and reflects two separate sources of noise: natural micro-saccades that the eye makes continuously even during a stable fixation, and frame-to-frame variation in the webcam's iris detection. The DBSCAN filter in `gaze-features.js` removes spatial outliers before computing features, which improves regression rate and saccade detection without affecting the debug dot position, since the dot comes from WebGazer's raw output before any of the extension's processing.

Calibration works by calling `webgazer.recordScreenPosition(x, y, 'click')` for each of 18 dot positions across two passes of a 9-point grid. Each call gives WebGazer one labelled training example for its internal ridge regression model. The accuracy of calibration depends entirely on clicking the centre of each dot accurately. A second calibration mode highlights the words of a paragraph one by one at natural reading speed, recording ~80 training examples from the actual reading zone without any clicking.

After any calibration, the regression model's training data is serialised and saved to extension storage, then restored on every subsequent page load. Combined with continuous click training (every click on any page is a labelled example), the tracker gets more accurate the longer the extension is used, rather than starting from scratch each session.

Eye tracking requires a secure context: HTTPS or localhost. It will not start on plain HTTP pages. On pages with strict Content Security Policies that block `tfhub.dev` — including Wikipedia, GitHub, and MDN — WebGazer's face detection model cannot load. The extension detects this upfront and shows a clear message rather than failing silently. Text selection summaries work normally on all pages regardless of CSP.

---

## Setup

**Backend server**

```
cd TL_DR/server
npm install
```

Create a file named `.env` in the server folder with the following content, replacing the placeholder with your actual Groq API key from console.groq.com:

```
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=llama-3.1-8b-instant
PORT=3000
```

Start the server with `node index.js`. To run it persistently in the background without keeping a terminal open, install pm2 globally with `npm install -g pm2`, then run `pm2 start index.js --name tldr-server` followed by `pm2 save`.

Verify the server is running by visiting `http://localhost:3000/health` in your browser.

**Chrome extension**

Navigate to `chrome://extensions`, enable Developer Mode in the top right, click Load Unpacked, and select the `TL_DR` folder that contains `manifest.json`. After any code change, click the refresh icon on the extension card to reload it.

**Retraining the classifier**

```
pip install numpy pandas scikit-learn matplotlib seaborn jupyter
jupyter notebook "tldr classifier/tldr_classifier_v2.ipynb"
```

Select Kernel then Restart and Run All. The notebook generates the dataset CSV, trains the decision tree, produces evaluation visualisations, and writes a new `classifier.js`. Copy the output file to `TL_DR/src/content/classifier.js` and reload the extension.

---

## Repository structure

```
TL_DR/
  manifest.json
  background.js               Service worker: message routing, file:// intercept
  assets/
    tldr.png
  src/
    content/
      content.js              Main orchestrator, runs on every page
      webgazer-bootstrap.js   Loads WebGazer in page context, postMessage bridge, model save/restore
      gaze-utils.js           Smoothing, calibration, velocity filter, model persistence
      gaze-features.js        9-feature extractor with DBSCAN noise filter
      classifier.js           Decision tree exported as JavaScript
      lang-detect.js          RTL/CJK script detection, SPA re-detection, feature patching
      comprehension-monitor.js  WPM baseline, too-fast/too-slow detection, backtrack
      reading-calibration.js  Word-by-word natural reading calibration
      session-tracker.js      Per-session state durations and reports
      tts-handler.js          Web Speech read-aloud with word highlighting
      focus-ruler.js          Horizontal dim-band following gaze
      dyslexia-utils.js       Dyslexia fonts, colour overlay, bionic reading, threshold patch
      reading-map.js          Sidebar: progress, heading minimap, event log
      idle-overlay.js         Edge pulse when user looks away
      overlay-utils.js        DOM block element finder
      pdf-handler.js          PDF text extraction
      pptx-handler.js         PPTX parsing via JSZip
    popup/
      popup.html              Extension popup (Assist / Accessibility / Session tabs)
      popup.js                Popup controller, personas, dark mode
      notes.html / notes.js   Saved notes dashboard
      session-report.html     Per-session reading report
      highlights.html         Saved paragraph highlights
      export.html             Session export
    pdf-viewer/viewer.html    Extension-hosted PDF.js viewer
    pptx-viewer/viewer.html   Extension-hosted PPTX viewer
    styles/
      overlay.css             Floating summary popup styles
    libs/
      webgazer.min.js         Bundled WebGazer
      jszip.min.js            Bundled JSZip
      pdfjs/                  Bundled PDF.js
  server/
    index.js                  Express server, Groq API proxy
    package.json
    .env                      API key, never committed
    .gitignore
tldr classifier/
  tldr_classifier_training.ipynb   Training notebook (v1)
  tldr_classifier_v2.ipynb         Training notebook (v2, current)
  gaze_dataset_v2.csv              Synthetic training data
```

---

## Security and privacy

No video is recorded, transmitted, or stored. WebGazer processes each camera frame locally and discards it immediately after extracting gaze coordinates. The extension stores only gaze feature statistics in memory, not raw coordinates. Calibration data is stored in `chrome.storage.local` as a simple pixel offset value.

The AI backend receives only the text of the paragraph being explained. It receives no gaze data, no video, no personal information. The Groq API key is stored in the server's `.env` file and is never exposed to the extension or the browser.

The `.env` file is listed in `.gitignore` and must never be committed to version control.

---

## Known limitations

WebGazer's face detection model downloads from `tfhub.dev` on startup. This domain is blocked by the CSP of several major sites. Eye tracking will not function on Wikipedia, GitHub, MDN, or similar sites with strict content policies. Text selection summaries work everywhere.

The classifier was trained on synthetic data. Until a real labelled gaze dataset is collected from actual reading sessions, the confusion-versus-focused distinction remains the weakest part of the system, particularly because webcam noise can make normal reading look slightly confused. The demo buttons in the popup — Simulate Confused and Simulate Overloaded — exist to demonstrate the full AI response pipeline independently of eye tracking accuracy.

---

## Planned features

Auto-scroll: a `requestAnimationFrame` loop calling `window.scrollBy` at a speed derived from gaze position relative to the viewport, pausing automatically when the classifier detects confusion.

Real gaze dataset: collecting and publishing a labelled dataset of real reading sessions (including RTL and CJK readers) to replace the synthetic training data and improve real-world accuracy.

Collaborative classroom mode: students' confusion events aggregated in real time into a heatmap the lecturer can see.

VS Code extension: applying the same classifier to code reading via the VS Code WebView API.

---

## Credits

Built by CJ. Eye tracking via WebGazer.js. AI inference via Groq. Decision tree training via scikit-learn.

Gaze distribution parameters derived from: Rayner, K. (1998), Psychological Bulletin; Just, M. A. and Carpenter, P. A. (1980), Psychological Review; Siegenthaler, E. et al. (2011), Displays; Schooler, J. W. et al. (2011), Trends in Cognitive Sciences.

MIT License.
