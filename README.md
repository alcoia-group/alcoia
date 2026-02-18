# ![TL;DR Logo](TL;DR/assets/tldr.png)    TL;DR — Cognitive-Aware AI Reading Assistant And Content Summarizer

> An AI + gaze-driven adaptive reading and coding companion.

---

## 🚀 Overview

**TL;DR** is a browser extension that enhances comprehension by analyzing reading patterns (via eye tracking) and dynamically adapting explanations, focus, and study flow in real time.

Unlike traditional AI assistants that wait for prompts, TL;DR responds to:

- Cognitive load  
- Confusion signals  
- Re-reading patterns  
- Attention drift  
- Fast vs passive reading  

---

## ✨ Core Features

### 1️⃣ Reverse Explanation Mode

Explains what text or code **does**, not just what it says.

- Step-by-step logic reconstruction  
- Author intent breakdown  
- Adaptive explanation depth  
- Confusion-triggered activation  

---

### 2️⃣ Focus Tunneling

Improves concentration by guiding visual attention.

- Dims peripheral content  
- Highlights active reading line  
- Activates only during reading patterns  
- Detects attention drift  

---

### 3️⃣ Zone-Out Detection (ZOD)

Differentiates between:

| Pattern | Behavior |
|----------|----------|
| Fast Reader | Smooth saccades, short fixations |
| Zoning Out | Long fixations, random drift |
| Overloaded | Frequent regressions |

Intervenes only when comprehension likely drops.

---

### 4️⃣ Code vs Text Detection

Automatically switches explanation logic depending on content type.

- Syntax detection  
- Structured markup recognition  
- Natural language mode  

---

### 5️⃣ Tutorial Re-Anchor

When returning after a break:

- Highlights last active section  
- Summarizes previous focus  
- Suggests next logical step  

---

### 6️⃣ Context-Aware Highlighting

AI highlights:

- Key logic blocks  
- Definitions  
- Complex segments  
- Dependencies  

---

### 7️⃣ Privacy Mode

- Local gaze processing  
- No raw gaze storage  
- Optional cloud AI for deep explanations  

---

# 🏗 Architecture

## Extension Layer

```
/src
 ├── background/
 ├── content/
 ├── ui/
 ├── gaze/
 └── ai/
manifest.json
```

### Components

- **Content Script** → DOM interaction  
- **Background Script** → State management  
- **UI Overlay (Shadow DOM)** → Conflict-free interface  
- **Gaze Engine** → Reading pattern detection  
- **AI Layer** → Explanation generation  

---

# 🧠 Gaze Engine Logic

## Fixation Detection

```javascript
if (distance(prevPoint, currentPoint) < 30) {
    fixationTime += delta;
}
```

## Confusion Trigger

```javascript
if (fixationTime > 400 && isMeaningfulWord && !isFastReader) {
    triggerReverseExplanation();
}
```

## Reader Classification (Simplified)

```javascript
if (shortFixations && smoothSaccades && lowRegressions) {
    mode = "fast_reader";
} else if (longFixations && randomSaccades) {
    mode = "zoning_out";
}
```

---

# 📊 Reading Pattern Signatures

## Fast Reader
- 100–200ms fixations  
- Smooth left-to-right saccades  
- Low regression rate  

## Zoning Out
- >800ms fixations  
- Random eye drift  
- Inconsistent scroll behavior  

## Cognitive Overload
- High regression frequency  
- Long fixations on dense text  
- Scroll stagnation  

---

# 🔧 Tech Stack

- JavaScript / TypeScript  
- Chrome Extension API (Manifest v3)  
- WebGazer.js (or custom gaze pipeline)  
- OpenAI API (optional premium mode)  
- Shadow DOM for UI isolation  

---

# 🛠 Development Setup

```bash
git clone https://github.com/Cjayy77/TL-DR.git
cd TL-DR
```

### Load Extension

1. Open Chrome  
2. Navigate to `chrome://extensions`  
3. Enable **Developer Mode**  
4. Click **Load Unpacked**  
5. Select project folder  

---

# 🧪 Roadmap

## Phase 1
- [x] Reverse Explanation Mode  
- [x] Basic Focus Tunneling  
- [x] Code/Text Detection  
- [ ] Local Gaze Classification  

## Phase 2
- [ ] Zone-Out Classifier Refinement  
- [ ] Learning Memory System  
- [ ] Adaptive Explanation Depth  

## Phase 3
- [ ] VS Code Integration  
- [ ] Local Small Model Support  
- [ ] Personalized Cognitive Profiles  

---

# 🔐 Privacy Policy

- No raw gaze coordinates stored  
- No biometric data transmitted  
- AI only processes selected text  
- Offline mode planned  

---

# 📈 Vision

TL;DR aims to become:

> The world’s first cognitive-aware AI interface.

Not just an AI that answers prompts —  
but one that understands how users process information.

---

# 🤝 Contributing

Pull requests are welcome.

1. Fork repository  
2. Create feature branch  
3. Submit PR  

---

# 📄 License

MIT License  

---

# ⭐ Future Expansion

- Gaze-to-command interface  
- Predictive viewport summaries  
- Hybrid local/cloud inference  
- Study memory graph  <3
- Adaptive reading modes  

---

