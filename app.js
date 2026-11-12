(function() {
    "use strict";

// --- PRNG & PREDICTABLE SHUFFLE ---

// A basic Linear Congruential Generator (LCG) for predictable random numbers
function createPRNG(seed) {
    return function() {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
    }
}

// Deterministically shuffles an array using the provided seed. Ensures the vocabulary chunks remain identical across reloads.
function seededShuffle(array, seed) {
    const prng = createPRNG(seed);
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(prng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}


// --- STATE MANAGEMENT ---
const AppState = {
    omniDatabase: [],
    sentenceDatabase: [],
    devSentenceDatabase: [],
    devSubsets: [],
    sentenceGroups: [],
    studyQueue: [],
    originalTotal: 0,
    completedCount: 0,
    currentStudyMode: 'translation',
    initialQueue: [],
    currentCategory: 'verb',
    knownWords: new Set(),
    isCorrectionMode: false,
    flashTimer: null,
    sessionResults: [],
    activeFuriganaIndex: -1,
    isKanjiDrawingMode: false,
    isGrading: false,
    lastSubmitTime: 0,
    isDevUnlocked: false,
    pendingNext: null,        // 漢字基礎１: feedback is showing; Enter / Next runs this to move on
    exam: null,               // 漢字基礎１ mock exam: { records, endsAt, timerId } while one is running
    devMasteredSubsets: new Set()
};

// Restore persistent states for exclusions
try {
    AppState.knownWords = new Set(JSON.parse(localStorage.getItem('japaneseStudyApp_KnownWords') || '[]'));
} catch (error) {
    console.warn('Failed to parse known words. Resetting to empty.');
    AppState.knownWords = new Set();
}

try {
    AppState.masteredSubsets = new Set(JSON.parse(localStorage.getItem('japaneseStudyApp_MasteredSubsets') || '[]'));
} catch (error) {
    console.warn('Failed to parse mastered subsets. Resetting to empty.');
    AppState.masteredSubsets = new Set();
}

try {
    AppState.devMasteredSubsets = new Set(JSON.parse(localStorage.getItem('japaneseStudyApp_DevMasteredSubsets') || '[]'));
} catch (error) {
    console.warn('Failed to parse dev mastered subsets. Resetting to empty.');
    AppState.devMasteredSubsets = new Set();
}

function saveKnownWords() {
    localStorage.setItem('japaneseStudyApp_KnownWords', JSON.stringify(Array.from(AppState.knownWords)));
}

function saveMasteredSubsets() {
    localStorage.setItem('japaneseStudyApp_MasteredSubsets', JSON.stringify(Array.from(AppState.masteredSubsets)));
}

function saveDevMasteredSubsets() {
    localStorage.setItem('japaneseStudyApp_DevMasteredSubsets', JSON.stringify(Array.from(AppState.devMasteredSubsets)));
}

// --- DOM ELEMENTS ---
const UI = {
    settingsSection: document.getElementById('settings-section'),
    estimatorText: document.getElementById('live-estimator'),
    studySection: document.getElementById('study-section'),
    startBtn: document.getElementById('start-btn'),
    submitBtn: document.getElementById('submit-btn'),
    revealBtn: document.getElementById('reveal-btn'),
    skipBtn: document.getElementById('skip-btn'),
    retakeBtn: document.getElementById('retake-btn'),
    answerInput: document.getElementById('answer-input'),
    groupBtnsContainer: document.getElementById('group-buttons-container'),
    promptText: document.querySelector('.prompt-text'),
    sessionCounter: document.querySelector('.session-counter'),
    
    conjugationSettingsContainer: document.getElementById('conjugation-settings-container'),
    verbFormsContainer: document.querySelector('[data-form-target]')?.closest('.settings-group'),
    jlptCheckboxes: document.querySelectorAll('[data-jlpt-target]'),
    groupCheckboxes: document.querySelectorAll('[data-group-target]'),
    formCheckboxes: document.querySelectorAll('[data-form-target]'),
    subsetContainer: document.getElementById('subset-checkboxes-container'),

    tabBtns: document.querySelectorAll('.tab-btn'),
    tabVerbs: document.getElementById('tab-verbs'),
    tabAdjectives: document.getElementById('tab-adjectives'),
    tabNouns: document.getElementById('tab-nouns'),
    tabSentences: document.getElementById('tab-sentences'),
    tabDev: document.getElementById('tab-dev'),
    tabKb1: document.getElementById('tab-kb1'),
    choiceBtnsContainer: document.getElementById('choice-buttons-container'),
    kb1NoneBtn: document.getElementById('kb1-none-btn'),
    kb1PractiseBtn: document.getElementById('kb1-practise-btn'),
    devLockView: document.getElementById('dev-lock-view'),
    devSettingsView: document.getElementById('dev-settings-view'),
    devPasswordInput: document.getElementById('dev-password-input'),
    devUnlockBtn: document.getElementById('dev-unlock-btn'),
    devErrorMsg: document.getElementById('dev-error-msg'),
    devSubsetStart: document.getElementById('dev-subset-start'),
    devSubsetEnd: document.getElementById('dev-subset-end'),
    devSubsetTo: document.getElementById('dev-subset-to'),
    devSubsetSingle: document.getElementById('dev-subset-single'),
    devSubsetRange: document.getElementById('dev-subset-range'),
    devHistoryIndicator: document.getElementById('dev-history-indicator'),
    jlptSettingsGroup: document.getElementById('jlpt-settings-group'),
    sentenceRangeSettingsGroup: document.getElementById('sentence-range-settings-group'),
    sentenceSubsetStart: document.getElementById('sentence-subset-start'),
    sentenceSubsetEnd: document.getElementById('sentence-subset-end'),
    sentenceSubsetEndWrapper: document.getElementById('sentence-subset-end-wrapper'),
    sentenceHistoryIndicator: document.getElementById('sentence-history-indicator'),
    audioSettingsGroup: document.getElementById('audio-settings-group'),
    subsetSettingsGroup: document.getElementById('subset-settings-group'),
    flashSettingsContainer: document.getElementById('flash-settings-container'),
    flashSpeedSlider: document.getElementById('flash-speed-slider'),
    flashSpeedNumber: document.getElementById('flash-speed-number'),
    flashLengthSlider: document.getElementById('flash-length-slider'),
    flashLengthNumber: document.getElementById('flash-length-number'),
    closeSessionBtn: document.getElementById('close-session-btn'),
    
    groupChoiceBtns: document.querySelectorAll('.group-btn'),
    audioToggleCheckbox: document.getElementById('audio-toggle'),
    bulkActionBtns: document.querySelectorAll('.bulk-action-btn'),

    audioToggleCorrectCheckbox: document.getElementById('audio-toggle-correct'),
    kanjiSettingsGroup: document.getElementById('kanji-settings-group'),
    kanjiPracticeToggle: document.getElementById('kanji-practice-toggle'),
    kanjiRevealToggle: document.getElementById('kanji-reveal-toggle'),
    kanjiInfoIcon: document.getElementById('kanji-info-icon'),
    kanjiTipBox: document.getElementById('kanji-tip-box'),
    srsInitialDelay: document.getElementById('srs-initial-delay'),
    srsFinalDelay: document.getElementById('srs-final-delay'),
};

// --- CORE ENGINE: SPACED REPETITION ---

// Standard Fisher-Yates Shuffle Algorithm for the active study queue
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Mode checks shared by the tabs. The 漢字基礎１ tab runs the same modes on class data.
function isGroupMode() {
    return AppState.currentStudyMode === 'group' && (AppState.currentCategory === 'verb' || AppState.currentCategory === 'kb1');
}
function isFlashMode() {
    return (AppState.currentCategory === 'sentence' || AppState.currentCategory === 'kb1') &&
        (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening');
}

// Manages the visibility of setting sections based on the selected study mode.
function updateModeUI() {
    const isVerbTab = AppState.currentCategory === 'verb';
    const isTranslation = AppState.currentStudyMode === 'translation';
    const isConjugation = AppState.currentStudyMode === 'conjugation';

    // These controls only exist within the Verbs tab
    if (isVerbTab) {
        if (UI.verbFormsContainer) {
            UI.verbFormsContainer.classList.toggle('hidden', !isTranslation);
        }
        UI.conjugationSettingsContainer.classList.toggle('hidden', !isConjugation);
    }

    // Toggle Flash/Listening settings specifically for the Sentences category
    if (UI.flashSettingsContainer) {
        const isFlashOrListening = isFlashMode();
        UI.flashSettingsContainer.classList.toggle('hidden', !isFlashOrListening);

        // Hide subsets specifically for Flash/Listening mode in Sentences tab
        if (UI.sentenceRangeSettingsGroup) {
            UI.sentenceRangeSettingsGroup.classList.toggle('hidden', isFlashOrListening);
        }
        
        // Hide speed multiplier specifically in Listening Mode
        const speedGroup = UI.flashSpeedSlider?.closest('.settings-group');
        if (speedGroup) {
            speedGroup.classList.toggle('hidden', AppState.currentStudyMode === 'listening');
        }
        
        // Hide flash display mode specifically in Listening Mode
        const displayModeGroup = document.querySelector('input[name="flash-display-mode"]')?.closest('.settings-group');
        if (displayModeGroup) {
            displayModeGroup.classList.toggle('hidden', AppState.currentStudyMode === 'listening');
        }
    }
    // Hide max length slider specifically for Reading mode
    if (UI.flashLengthSlider) {
        const lengthGroup = UI.flashLengthSlider.closest('.settings-group');
        if (lengthGroup) {
            lengthGroup.classList.toggle('hidden', !isFlashMode());
        }
    }

    // Toggle Final Review Delay visibility based on Kanji Practice Mode
    const finalDelayWrapper = document.getElementById('final-delay-wrapper');
    const kanjiToggle = document.getElementById('kanji-practice-toggle');
    
    if (finalDelayWrapper && kanjiToggle) {
        finalDelayWrapper.classList.toggle('hidden', kanjiToggle.checked);
    }
}

/**
 * Handles switching between study categories (Verbs, Adjectives, Nouns).
 */
function switchTab(category) {
    AppState.currentCategory = category;

    // ADD THIS: Sync Study Mode state based on the newly selected tab
    if (category === 'sentence') {
        AppState.currentStudyMode = document.querySelector('input[name="sentence-study-mode"]:checked')?.value || 'reading';
    } else if (category === 'verb') {
        AppState.currentStudyMode = document.querySelector('input[name="verb-study-mode"]:checked')?.value || 'translation';
    } else if (category === 'dev') {
        AppState.currentStudyMode = 'reading';
    } else if (category === 'kb1') {
        AppState.currentStudyMode = document.querySelector('input[name="kb1-mode"]:checked')?.value || 'kb1-reading-typed';
    }

    const targetId = (category === 'dev' || category === 'kb1') ? `tab-${category}` : `tab-${category}s`;

    // Update active class on the tab buttons
    UI.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === targetId);
    });

    // Toggle visibility of content wrappers
    [UI.tabVerbs, UI.tabAdjectives, UI.tabNouns, UI.tabSentences, UI.tabDev, UI.tabKb1].forEach(panel => {
        if (panel) panel.classList.toggle('hidden', panel.id !== targetId);
    });

    // Toggle visibility of specific settings groups for Sentences, Dev and 漢字基礎１ tabs
    const hideCommonGroups = category === 'sentence' || category === 'dev' || category === 'kb1';
    [UI.jlptSettingsGroup, UI.subsetSettingsGroup, UI.audioSettingsGroup, UI.kanjiSettingsGroup].forEach(group => {
        if (group) group.classList.toggle('hidden', hideCommonGroups);
    });
    // Class questions read the answer aloud like the vocabulary tabs, so keep the audio options there
    if (category === 'kb1' && UI.audioSettingsGroup) UI.audioSettingsGroup.classList.remove('hidden');

    // Refresh the UI state for the selected category
    renderSubsetCheckboxes();
    updateModeUI();
    saveSettings();
    updateLiveEstimator();
}


// Renders one "known words" list (check to exclude): a filter box, then one checkbox per word.
// Used by the Verbs/Adjectives/Nouns tabs and by the 漢字基礎１ tab (class words, same format).
function renderMasterList(container, words, label, labelFn) {
    if (!container) return;
    const describe = labelFn || (word => `${word.base.kana} (${word.meaning})`);
    container.innerHTML = `
        <div style="grid-column: 1 / -1; margin-bottom: 1rem; width: 100%; display: flex; flex-direction: column; gap: 0.5rem;">
            <input type="text" class="answer-input master-list-filter" 
                   placeholder="Filter ${label} by word or meaning..." 
                   style="text-align: left; font-size: 1rem; padding: 0.6rem 1rem;">
            <label class="checkbox-label kana-toggle-label" style="font-size: 0.85rem; color: var(--text-secondary); width: fit-content;">
                <input type="checkbox" class="kana-toggle" checked>
                <span class="custom-checkbox" style="width: 16px; height: 16px;"></span>
                Use Kana Input
            </label>
        </div>
    `;
    const escape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    container.insertAdjacentHTML('beforeend', words.map(word => `
        <label class="checkbox-label active-option">
            <input type="checkbox" class="known-word-toggle" value="${escape(word.id)}" ${AppState.knownWords.has(word.id) ? 'checked' : ''}>
            <span class="custom-checkbox"></span>
            ${escape(describe(word))}
        </label>
    `).join(''));

    const filterInput = container.querySelector('.master-list-filter');
    const kanaToggle = container.querySelector('.kana-toggle');

    // Enable Japanese IME Support
    wanakana.bind(filterInput, { IMEMode: true });

    kanaToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            wanakana.bind(filterInput, { IMEMode: true });
        } else {
            wanakana.unbind(filterInput);
        }
    });

    filterInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase().trim();
        container.querySelectorAll('.checkbox-label:not(.kana-toggle-label)').forEach(lbl => {
            lbl.classList.toggle('hidden', !lbl.textContent.toLowerCase().includes(term));
        });
    });
}

 // Renders the master vocabulary lists for all categories to allow word exclusion.
function renderMasterLists() {
    renderMasterList(document.getElementById('master-list-verbs'), AppState.omniDatabase.filter(w => w.type === 'verb'), 'verbs');
    renderMasterList(document.getElementById('master-list-adjectives'), AppState.omniDatabase.filter(w => w.type === 'adjective'), 'adjectives');
    renderMasterList(document.getElementById('master-list-nouns'), AppState.omniDatabase.filter(w => w.type === 'noun'), 'nouns');
}

// Renders the 110 Sentence Subsets into the exclusion master list.
function renderSentenceMasterList() {
    const container = document.getElementById('master-list-sentences');
    if (!container) return;
    
    const html = [];
    for (let i = 1; i <= 110; i++) {
        const isChecked = AppState.masteredSubsets.has(i.toString());
        html.push(`
            <label class="checkbox-label active-option">
                <input type="checkbox" class="mastered-subset-toggle" value="${i}" ${isChecked ? 'checked' : ''}>
                <span class="custom-checkbox"></span>
                Subset ${i}
            </label>
        `);
    }
    container.innerHTML = html.join('');
}

// Dynamically builds the subset checkboxes based on active JLPT and Verb Group filters.
function renderSubsetCheckboxes() {
    if (!AppState.omniDatabase) return;

    // Handle Sentences, Dev and 漢字基礎１ category transition
    if (AppState.currentCategory === 'sentence' || AppState.currentCategory === 'dev' || AppState.currentCategory === 'kb1') {
        // UI is now handled statically by the number inputs in HTML
        return;
    }

    // Get filtering criteria configuration for the current tab
    const panelMap = {
        'verb': { panel: UI.tabVerbs, selector: '[data-group-target]', attr: 'groupTarget' },
        'adjective': { panel: UI.tabAdjectives, selector: '[data-adj-group]', attr: 'adjGroup' },
        'noun': { panel: UI.tabNouns, selector: '[data-noun-group]', attr: 'nounGroup' }
    };
    const config = panelMap[AppState.currentCategory];

    const activeLevels = Array.from(UI.jlptCheckboxes).filter(cb => cb.checked).map(cb => cb.dataset.jlptTarget);
    const activeGroups = Array.from(config.panel.querySelectorAll(config.selector))
        .filter(cb => cb.checked)
        .map(cb => cb.dataset[config.attr]);

    // 1. Filter
    let filtered = AppState.omniDatabase.filter(word => 
        word.type === AppState.currentCategory &&
        activeLevels.includes(word.jlptLevel) && 
        activeGroups.includes(word.subType)
    );

    // 2. Alphabetical Sort
    filtered.sort((a, b) => a.base.romaji.localeCompare(b.base.romaji));

    // 3. Seeded Shuffle
    filtered = seededShuffle(filtered, 12345);

    // 4. Calculate Chunks
    const totalWords = filtered.length;
    const chunkSize = 10;
    const chunks = Math.ceil(totalWords / chunkSize);

    // 5. Render Checkboxes
    UI.subsetContainer.innerHTML = '';
    
    let settingsState = {};
    try {
        const savedData = localStorage.getItem('japaneseStudyApp_Settings');
        if (savedData) settingsState = JSON.parse(savedData);
    } catch (error) {
        console.warn('Failed to parse settings from localStorage for subset rendering.', error);
    }

    const htmlArray = [];
    for (let i = 0; i < chunks; i++) {
        const start = i * chunkSize + 1;
        const end = Math.min((i + 1) * chunkSize, totalWords);
        const label = `${start}-${end}`;
        const cbId = `subset-${i}`;
        
        // Restore saved subset state, default to true if not found
        const isChecked = settingsState[cbId] !== undefined ? settingsState[cbId] : true;

        const html = `
            <label class="checkbox-label active-option">
                <input type="checkbox" id="${cbId}" data-subset-index="${i}" ${isChecked ? 'checked' : ''}>
                <span class="custom-checkbox"></span>
                ${label}
            </label>
        `;
        htmlArray.push(html);
    }
    UI.subsetContainer.innerHTML = htmlArray.join('');
}

// Helper to retrieve the active chunked vocabulary list based on all filters.
function getFilteredAndChunkedVocab() {
    if (!AppState.omniDatabase) return [];

    if (AppState.currentCategory === 'sentence' || AppState.currentCategory === 'dev' || AppState.currentCategory === 'kb1') {
        return [];
    }

    const panelMap = {
        'verb': { panel: UI.tabVerbs, selector: '[data-group-target]', attr: 'groupTarget' },
        'adjective': { panel: UI.tabAdjectives, selector: '[data-adj-group]', attr: 'adjGroup' },
        'noun': { panel: UI.tabNouns, selector: '[data-noun-group]', attr: 'nounGroup' }
    };
    const config = panelMap[AppState.currentCategory];

    const activeLevels = Array.from(UI.jlptCheckboxes).filter(cb => cb.checked).map(cb => cb.dataset.jlptTarget);
    const activeGroups = Array.from(config.panel.querySelectorAll(config.selector))
        .filter(cb => cb.checked)
        .map(cb => cb.dataset[config.attr]);

    let filtered = AppState.omniDatabase.filter(word => 
        word.type === AppState.currentCategory &&
        activeLevels.includes(word.jlptLevel) && 
        activeGroups.includes(word.subType)
    );

    // Apply strict sorting and deterministic shuffling
    filtered.sort((a, b) => a.base.romaji.localeCompare(b.base.romaji));
    filtered = seededShuffle(filtered, 12345);

    // Filter by active subsets
    const subsetCheckboxes = document.querySelectorAll('[data-subset-index]');
    const activeSubsets = Array.from(subsetCheckboxes)
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.subsetIndex, 10));

    const chunkSize = 10;
    filtered = filtered.filter((word, index) => {
        const chunkIndex = Math.floor(index / chunkSize);
        return activeSubsets.includes(chunkIndex);
    });

    // 6. Exclude known words
    filtered = filtered.filter(word => !AppState.knownWords.has(word.id));

    return filtered;
}


// Calculates the expected number of flashcards based on current settings.

function updateLiveEstimator() {
    // --- 漢字基礎１ CATEGORY ESTIMATOR ---
    if (AppState.currentCategory === 'kb1') {
        UI.estimatorText.innerHTML = window.KB1 ? window.KB1.estimateHtml() : 'Estimated Flashcards: <span>Locked</span>';
        return;
    }

    // --- DEV CATEGORY ESTIMATOR ---
    if (AppState.currentCategory === 'dev') {
        if (!AppState.isDevUnlocked || !AppState.devSubsets || AppState.devSubsets.length === 0) {
            UI.estimatorText.innerHTML = `Estimated Flashcards: <span>Locked</span>`;
            return;
        }

        const isDevSingle = UI.devSubsetSingle ? UI.devSubsetSingle.checked : (UI.settingsSection.querySelector('input[name="dev-subset-mode"]:checked')?.value === 'single');
        let startVal = parseInt(UI.devSubsetStart?.value, 10) || 1;
        let endVal = isDevSingle ? startVal : (parseInt(UI.devSubsetEnd?.value, 10) || startVal);

        // Clamp to 1-42
        startVal = Math.max(1, Math.min(42, startVal));
        endVal = Math.max(1, Math.min(42, endVal));

        if (startVal > endVal) {
            const temp = startVal;
            startVal = endVal;
            endVal = temp;
        }

        let estimatedCount = 0;
        for (let s = startVal; s <= endVal; s++) {
            if (!AppState.devMasteredSubsets.has(s.toString())) {
                const subset = AppState.devSubsets[s - 1];
                if (subset) {
                    estimatedCount += subset.length;
                }
            }
        }
        UI.estimatorText.innerHTML = `Estimated Flashcards: <span>${estimatedCount}</span>`;
        return;
    }

    // --- SENTENCE CATEGORY ESTIMATOR ---
    if (AppState.currentCategory === 'sentence') {
        if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
            UI.estimatorText.innerHTML = 'Estimated Flashcards: <span>Endless</span>';
            return;
        }

        const isSingleMode = UI.settingsSection.querySelector('input[name="subset-mode"]:checked')?.value === 'single';
        let startVal = parseInt(UI.sentenceSubsetStart.value, 10);
        let endVal = isSingleMode ? startVal : parseInt(UI.sentenceSubsetEnd.value, 10);
        if (isNaN(endVal)) endVal = startVal;

        // Auto-swap for the estimate math if entered backwards
        if (startVal > endVal) {
            const temp = startVal;
            startVal = endVal;
            endVal = temp;
        }
        
        let estimatedCount = 0;
        if (!isNaN(startVal)) {
            let activeSubsets = 0;
            for (let s = startVal; s <= endVal; s++) {
                if (!AppState.masteredSubsets.has(s.toString())) {
                    activeSubsets++;
                }
            }
            estimatedCount = activeSubsets * 9; // 3 groups * 3 sentences
        }
        UI.estimatorText.innerHTML = `Estimated Flashcards: <span>${estimatedCount}</span>`;
        return;
    }

    // --- VOCABULARY CATEGORY ESTIMATOR ---
    const isGroupActive = isGroupMode();
    const filteredVocab = getFilteredAndChunkedVocab();

    let estimatedCount = 0;

    if (isGroupActive) {
        estimatedCount = filteredVocab.length;
    } else {
        const panelMap = {
            'verb': { panel: UI.tabVerbs, selector: '[data-form-target]', attr: 'formTarget' },
            'adjective': { panel: UI.tabAdjectives, selector: '[data-adj-form]', attr: 'adjForm' },
            'noun': { panel: UI.tabNouns, selector: null, attr: null }
        };
        const config = panelMap[AppState.currentCategory];

        const activeForms = config.selector ? Array.from(config.panel.querySelectorAll(config.selector))
            .filter(cb => cb.checked)
            .map(cb => cb.dataset[config.attr]) : ['base'];

        filteredVocab.forEach(word => {
            activeForms.forEach(formKey => {
                const targetForm = formKey === 'base' ? word.base : (word.forms ? word.forms[formKey] : null);
                if (targetForm && (targetForm.kana || targetForm.romaji)) {
                    estimatedCount++;
                }
            });
        });
    }

    UI.estimatorText.innerHTML = `Estimated Flashcards: <span>${estimatedCount}</span>`;
}


// --- QUESTION BUILDERS ---
// Shared by the vocabulary tabs, Sentences/Dev and 漢字基礎１. Each takes entries in the app's own
// formats (data.json words, sentence_data.json sentences) and returns study-queue questions.

// Flash & Listening: an endless queue of sentences (sentence_data.json format), limited by the
// Max Character Length setting, with recently seen ones moved to the back.
function buildFlashQuestions(sentenceList) {
    let sentences = [...sentenceList];
    
    // Filter out sentences longer than user-defined characters (ignoring punctuation)
    const maxLen = parseInt(UI.flashLengthNumber.value, 10) || 15;
    const cleanPunctuation = (str) => str.replace(/[。、？！\.\?!, ]/g, '');
    sentences = sentences.filter(s => cleanPunctuation(s.japanese_reading).length <= maxLen);
    
    // Retrieve memory of recently seen cards
    let flashMemory = [];
    try {
        flashMemory = JSON.parse(localStorage.getItem('japaneseStudyApp_FlashMemory') || '[]');
    } catch (e) {}

    // Shuffle all valid sentences randomly
    sentences = shuffleArray(sentences);
    
    // Push recently seen sentences to the back of the queue
    sentences.sort((a, b) => {
        const aSeen = flashMemory.includes(a.id) ? 1 : 0;
        const bSeen = flashMemory.includes(b.id) ? 1 : 0;
        return aSeen - bSeen; 
    });

    // Map to the study queue format
    const rawQuestions = sentences.map(item => {
        const displayMode = UI.settingsSection.querySelector('input[name="flash-display-mode"]:checked')?.value || 'kana';
        const flashContent = displayMode === 'kana' ? item.japanese_reading : item.japanese_text;

        return {
            type: 'sentence',
            wordId: item.id,
            flashContent: flashContent,
            promptText: AppState.currentStudyMode === 'listening' ? `Listen and type the sentence:` : `Type the sentence you saw:`,
            correctAnswerKana: cleanPunctuation(item.japanese_reading),
            correctAnswerRomaji: '___NO_ROMAJI___',
            readText: item.japanese_reading,
            step: 0
        };
    });
    
    AppState.originalTotal = '∞';
    return rawQuestions;
}

// Sentence reading (Sentences, Dev and 漢字基礎１): one sentence in sentence_data.json format.
function buildReadingQuestion(item, extra = {}) {
    return Object.assign({
        type: 'sentence',
        wordId: item.id,
        flashContent: item.japanese_reading,
        components: item.components, // Pass components down
        japaneseText: item.japanese_text, // Pass base text
        promptText: 'Type the kana reading. Use "-" to skip a word.',
        correctAnswerKana: item.japanese_reading.replace(/[。、？！\.\?!, ]/g, ''),
        correctAnswerRomaji: '___NO_ROMAJI___',
        readText: item.japanese_reading,
        step: 0
    }, extra);
}

// Verb group identification (Verbs tab, 漢字基礎１): words in data.json format.
function buildGroupQuestions(words) {
    return words.map(word => {
        const exceptionMarker = word.isException ? ' ⚠️' : '';
        return {
            wordId: word.id,
            formKey: 'base', 
            promptText: `Identify Group: <span>${word.base.kana} (${word.meaning})${exceptionMarker}</span>`,
            correctAnswer: word.subType,
            step: 0
        };
    });
}

// Meaning -> word, typed (Nouns tab, 漢字基礎１): words in data.json format.
function buildNounQuestions(words) {
    return words.map(word => ({
        wordId: word.id,
        formKey: 'base',
        promptText: `Translate: <span>${word.meaning}</span>`,
        correctAnswerKana: word.base.kana,
        correctAnswerRomaji: word.base.romaji,
        readText: word.base.kana,
        kanjiText: word.base.kanji || '',
        step: 0
    }));
}

// Parses settings, filters omniDatabase, and builds the study queue.

function initializeSession() {
    const isGroupActive = isGroupMode();
    const isConjugationActive = AppState.currentStudyMode === 'conjugation' && AppState.currentCategory === 'verb';
    const filteredVocab = getFilteredAndChunkedVocab();
    let rawQuestions = [];
    // Reset the "endless" marker a previous Flash/Listening session may have left behind
    AppState.originalTotal = 0;

    // --- 漢字基礎１ (class section): the class data is in the app's own formats, so the existing
    // modes use the shared builders; only the class-only modes come from kb1_core.js ---
    if (AppState.currentCategory === 'kb1') {
        const src = window.KB1 ? window.KB1.source() : null;
        if (!src) return;
        const mode = AppState.currentStudyMode;
        if (mode === 'translation') rawQuestions = buildNounQuestions(src.words);
        else if (mode === 'reading') rawQuestions = src.sentences.map(s => buildReadingQuestion(s, {
            englishTranslation: s.english_translation, showTranslation: true }));
        else rawQuestions = KB1Core.buildQueue(src, mode, src.opts);
        startExamState(mode === 'kb1-exam' ? src.opts : null);
    } else
    // --- NEW SENTENCE GATHERING LOGIC ---
    if (AppState.currentCategory === 'sentence') {
        
        if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
            // --- ENDLESS FLASH / LISTENING LOGIC ---
            rawQuestions = buildFlashQuestions(AppState.sentenceDatabase);

        } else {
            // --- RANGE SELECTION LOGIC (For Reading Mode) ---
            const isSingleMode = UI.settingsSection.querySelector('input[name="subset-mode"]:checked')?.value === 'single';
            let startVal = parseInt(UI.sentenceSubsetStart.value, 10);
            let endVal = isSingleMode ? startVal : parseInt(UI.sentenceSubsetEnd.value, 10);
            
            if (isNaN(startVal)) {
                alert("Please enter a Subset number.");
                return;
            }
            
            if (isNaN(endVal)) endVal = startVal;

            // Silently swap if the user entered them backwards
            if (startVal > endVal) {
                const temp = startVal;
                startVal = endVal;
                endVal = temp;
                
                // Update the UI so it visually corrects itself (only if they are actually in range mode)
                if (!isSingleMode) {
                    UI.sentenceSubsetStart.value = startVal;
                    UI.sentenceSubsetEnd.value = endVal;
                    saveSettings();
                }
            }

            if (startVal < 1 || endVal > 110) {
                alert("Please enter a valid subset range (1 - 110).");
                return;
            }

            // Record History
            updateSentenceHistory(startVal, endVal);

            let selectedGroups = [];
            
            // Subsets are 1-indexed for the user. Translate them to 0-index.
            // 1 Subset = 3 Groups
            // Subsets are 1-indexed for the user. Translate them to 0-index.
            // 1 Subset = 3 Groups
            for (let subset = startVal; subset <= endVal; subset++) {
                // --- EXCLUSION LOGIC ---
                if (AppState.masteredSubsets.has(subset.toString())) continue; 

                const groupStartIndex = (subset - 1) * 3;
                
                const group1 = AppState.sentenceGroups[groupStartIndex];
                const group2 = AppState.sentenceGroups[groupStartIndex + 1];
                const group3 = AppState.sentenceGroups[groupStartIndex + 2];
                
                if (group1) selectedGroups.push(group1);
                if (group2) selectedGroups.push(group2);
                if (group3) selectedGroups.push(group3);
            }

            if (selectedGroups.length === 0) {
                alert("No sentences found in this range.");
                return;
            }

            // Randomize groups
            selectedGroups = shuffleArray(selectedGroups);

            rawQuestions = selectedGroups.flatMap(group => {
                const shuffledGroup = shuffleArray(group);
                return shuffledGroup.map(item => buildReadingQuestion(item));
            });
        }
    } else if (AppState.currentCategory === 'dev') {
        if (!AppState.isDevUnlocked || !AppState.devSubsets || AppState.devSubsets.length === 0) {
            alert("Please unlock the Dev Sandbox first.");
            return;
        }

        const isDevSingle = UI.devSubsetSingle ? UI.devSubsetSingle.checked : (UI.settingsSection.querySelector('input[name="dev-subset-mode"]:checked')?.value === 'single');
        let startVal = parseInt(UI.devSubsetStart?.value, 10) || 1;
        let endVal = isDevSingle ? startVal : (parseInt(UI.devSubsetEnd?.value, 10) || startVal);

        // Clamp both values between 1 and 42
        startVal = Math.max(1, Math.min(42, startVal));
        endVal = Math.max(1, Math.min(42, endVal));

        // Silently swap if entered backwards
        if (startVal > endVal) {
            const temp = startVal;
            startVal = endVal;
            endVal = temp;
            if (!isDevSingle && UI.devSubsetStart && UI.devSubsetEnd) {
                UI.devSubsetStart.value = startVal;
                UI.devSubsetEnd.value = endVal;
                saveSettings();
            }
        }

        // Record History
        updateDevSentenceHistory(startVal, endVal);

        let selectedSubsets = [];
        for (let s = startVal; s <= endVal; s++) {
            if (AppState.devMasteredSubsets.has(s.toString())) continue;
            const subset = AppState.devSubsets[s - 1];
            if (subset) selectedSubsets.push(subset);
        }

        if (selectedSubsets.length === 0) {
            alert("No sentences found in this range or all selected subsets are excluded.");
            return;
        }

        selectedSubsets = shuffleArray(selectedSubsets);

        rawQuestions = selectedSubsets.flatMap(subset => {
            const shuffledSubset = shuffleArray(subset);
            return shuffledSubset.map(item => buildReadingQuestion(item, {
                englishTranslation: item.english_meaning || item.english || ''
            }));
        });
    } else if (isGroupActive) {
        // --- MODE 1: Verb Group Identification ---
        rawQuestions = buildGroupQuestions(filteredVocab);
    } else if (isConjugationActive) {
        // --- MODE 2: Verb Conjugation (Single Form to Form) ---
        const givenKey = UI.settingsSection.querySelector('input[name="given-form"]:checked')?.value;
        const targetKey = UI.settingsSection.querySelector('input[name="target-form"]:checked')?.value;
        const formNameMap = { 'base': 'Dictionary', 'masu': 'Masu', 'te': 'Te', 'ta': 'Ta', 'nai': 'Nai' };

        if (!givenKey || !targetKey || givenKey === targetKey) {
            alert("Please ensure you have selected two different forms for conjugation.");
            return;
        }

        filteredVocab.forEach(word => {
            const givenForm = givenKey === 'base' ? word.base : (word.forms ? word.forms[givenKey] : null);
            const targetForm = targetKey === 'base' ? word.base : (word.forms ? word.forms[targetKey] : null);
            if (!givenForm || !targetForm) return;

            rawQuestions.push({
                wordId: word.id,
                formKey: targetKey,
                promptText: `Conjugate: <span>${givenForm.kana} &rarr; ${formNameMap[targetKey]}</span>`,
                correctAnswerKana: targetForm.kana,
                correctAnswerRomaji: targetForm.romaji,
                readText: targetForm.kana,
                kanjiText: targetForm.kanji || '',
                step: 0
            });
        });
    } else if (AppState.currentCategory === 'noun') {
        // --- MODE 3: Noun Translation ---
        rawQuestions = buildNounQuestions(filteredVocab);
    } else {
        // --- MODE 4: Translation (Verbs/Adjectives) ---
        const activeForms = AppState.currentCategory === 'verb'
            ? Array.from(UI.formCheckboxes).filter(cb => cb.checked).map(cb => cb.dataset.formTarget)
            : Array.from(UI.tabAdjectives.querySelectorAll('[data-adj-form]')).filter(cb => cb.checked).map(cb => cb.dataset.adjForm);

        filteredVocab.forEach(word => {
            activeForms.forEach(formKey => {
                const targetForm = formKey === 'base' ? word.base : (word.forms ? word.forms[formKey] : null);
                const displayFormName = formKey === 'base' ? 'Dictionary' : 
                                        formKey.charAt(0).toUpperCase() + formKey.slice(1);

                if (targetForm && (targetForm.kana || targetForm.romaji)) {
                    rawQuestions.push({
                        wordId: word.id,
                        formKey: formKey,
                        promptText: `Translate: <span>${word.meaning} &rarr; ${displayFormName}-form</span>`,
                        correctAnswerKana: targetForm.kana,
                        correctAnswerRomaji: targetForm.romaji,
                        readText: targetForm.kana,
                        kanjiText: targetForm.kanji || '',
                        step: 0
                    });
                }
            });
        });
    }

    if (rawQuestions.length === 0) {
        alert("Please ensure you have selected valid criteria to start.");
        return;
    }

    // Prepare queue
    if (AppState.originalTotal === '∞') {
        // Already shuffled and sorted by Memory logic
        AppState.studyQueue = rawQuestions;
    } else {
        AppState.studyQueue = shuffleArray(rawQuestions);
        AppState.originalTotal = AppState.studyQueue.length;
    }

    AppState.initialQueue = [...AppState.studyQueue]; 
    AppState.sessionResults = [];
    AppState.completedCount = 0;
    AppState.isGrading = false;
    AppState.lastSubmitTime = 0;

    UI.settingsSection.classList.add('hidden');
    UI.studySection.classList.remove('hidden');
    
    if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
        UI.revealBtn.textContent = 'End Session';
    }

    toggleUIInputs();
    loadNextQuestion();
}

// True when the question is a sentence to read (Sentences/Dev reading mode, or a class sentence)
function isReadingQuestion(question) {
    if (AppState.currentCategory === 'kb1') return AppState.currentStudyMode === 'reading';
    return (AppState.currentCategory === 'sentence' || AppState.currentCategory === 'dev') && AppState.currentStudyMode === 'reading';
}

// Multiple-choice buttons (class questions). Clicking one, or pressing 1-4, submits it.
function renderChoiceButtons(question) {
    const box = UI.choiceBtnsContainer;
    if (!box) return;
    box.innerHTML = '';
    question.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary choice-btn';
        btn.dataset.choiceIndex = String(i);
        if (question.choicesLang) btn.lang = question.choicesLang;
        const num = document.createElement('span');
        num.className = 'choice-num';
        num.textContent = String(i + 1);
        const label = document.createElement('span');
        label.className = 'choice-label';
        label.textContent = choice;
        btn.append(num, label);
        box.appendChild(btn);
    });
    box.classList.remove('hidden');
}

function toggleUIInputs() {
    if (AppState.currentCategory === 'kb1' && !isGroupMode()) {   // chosen per question in loadNextQuestion
        UI.groupBtnsContainer.classList.add('hidden');
        return;
    }
    const isGroupActive = isGroupMode();
    if (isGroupActive) {
        UI.answerInput.classList.add('hidden');
        UI.submitBtn.classList.add('hidden'); 
        UI.groupBtnsContainer.classList.remove('hidden');
    } else {
        UI.answerInput.classList.remove('hidden');
        UI.submitBtn.classList.remove('hidden');
        UI.groupBtnsContainer.classList.add('hidden');
    }
}

async function loadNextQuestion() {
    if (AppState.studyQueue.length === 0) {
        finishSession();
        return;
    }

    const currentQuestion = AppState.studyQueue[0];

    // Class questions switch between typed answers, buttons and sentences from card to card
    if (AppState.currentCategory === 'kb1' && UI.choiceBtnsContainer && !isGroupMode() && !isFlashMode()) {
        const isChoice = !!currentQuestion.choices;
        UI.choiceBtnsContainer.classList.toggle('hidden', !isChoice);
        UI.answerInput.classList.toggle('hidden', isChoice);
        UI.submitBtn.classList.toggle('hidden', isChoice);
        UI.revealBtn.classList.remove('hidden');
        UI.answerInput.readOnly = false;
        if (UI.kb1NoneBtn) UI.kb1NoneBtn.classList.toggle('hidden', !currentQuestion.allowNone);
        if (isChoice) renderChoiceButtons(currentQuestion);
        if (AppState.exam) {             // exam: no Reveal; typed answers go with Next
            UI.revealBtn.classList.add('hidden');
            UI.submitBtn.textContent = 'Next →';
        }
    } else if (UI.kb1NoneBtn) {
        UI.kb1NoneBtn.classList.add('hidden');
    }

    if (isReadingQuestion(currentQuestion)) {
        const renderedSentence = currentQuestion.components 
            ? renderReadingSentence(currentQuestion.japaneseText, currentQuestion.components, AppState.activeFuriganaIndex)
            : currentQuestion.japaneseText;

        UI.promptText.innerHTML = `<div style="font-size: 2.2rem; color: var(--accent-color); margin-bottom: 1rem;">${renderedSentence}</div><div style="font-size: 1rem; color: var(--text-secondary);">${currentQuestion.promptText}</div>`;
        UI.promptText.style.fontSize = ''; 
        UI.promptText.style.color = '';
        
        UI.answerInput.value = '';
        UI.answerInput.classList.remove('hidden');
        UI.submitBtn.classList.remove('hidden');
        UI.revealBtn.classList.add('hidden');
        UI.answerInput.focus();
    }
    
    // --- FLASH & LISTENING MODE LOGIC ---
    else if (isFlashMode()) {
        if (AppState.currentStudyMode === 'flash') {
            // Hide input area initially
            UI.answerInput.value = '';
            UI.answerInput.classList.add('hidden');
            UI.submitBtn.classList.add('hidden');
                    
            // Show the giant Japanese sentence
            UI.promptText.innerHTML = currentQuestion.flashContent;
            UI.promptText.style.fontSize = '2.5rem';
            UI.promptText.style.color = 'var(--accent-color)';
            UI.promptText.classList.remove('hidden');

            // Calculate time: length / 2.5 chars per second * multiplier
            const speedMultiplier = parseFloat(UI.flashSpeedNumber.value || 1);
            const displayTimeMs = (currentQuestion.flashContent.length / 2.5) * 1000 * speedMultiplier;

            AppState.flashTimer = setTimeout(() => {
                // Revert the styles and switch to the input mode
                UI.promptText.innerHTML = currentQuestion.promptText;
                UI.promptText.style.fontSize = ''; 
                UI.promptText.style.color = '';
                
                UI.answerInput.classList.remove('hidden');
                UI.submitBtn.classList.remove('hidden');
                UI.revealBtn.classList.remove('hidden');
                UI.answerInput.focus();
            }, displayTimeMs);
        } else if (AppState.currentStudyMode === 'listening') {
            // Setup UI for listening
            UI.promptText.innerHTML = currentQuestion.promptText + ' <button id="replay-audio-btn" style="background:none; border:none; cursor:pointer; font-size:1.2rem; vertical-align:middle; margin-left:10px;">🔊</button>';
            UI.promptText.style.fontSize = ''; 
            UI.promptText.style.color = '';
            
            UI.answerInput.value = '';
            UI.answerInput.classList.remove('hidden');
            UI.submitBtn.classList.remove('hidden');
            UI.revealBtn.classList.remove('hidden');
            UI.answerInput.focus();
            
            // Add replay functionality
            document.getElementById('replay-audio-btn').addEventListener('click', () => {
                speakJapanese(currentQuestion.readText);
                UI.answerInput.focus();
            });

            // Auto-play audio on load
            speakJapanese(currentQuestion.readText);
        }
    } else {
        // --- STANDARD VOCAB MODE ---
        const isGroupActive = isGroupMode();

        if (currentQuestion.step === 'kanji_review') {
            // Auto-trigger Drawing Mode for review cards
            AppState.isKanjiDrawingMode = true;
            UI.promptText.innerHTML = `<span style="color: var(--text-secondary); font-size: 1.2rem;">Loading Stroke Order...</span>`;
            
            const components = await buildKanjiPracticeData(currentQuestion.kanjiText);
            
            let html = `<div class="kanji-practice-container">`;
            components.forEach(comp => {
                if (comp.type === 'kanji') {
                    html += `<div class="kanji-svg-wrapper">${comp.svg}</div>`;
                } else {
                    html += `<div class="kana-text-wrapper">${comp.char}</div>`;
                }
            });
            html += `</div>`;
            html += `<div style="font-size: 1rem; color: var(--text-secondary);">${currentQuestion.promptText}</div>`;
            
            UI.promptText.innerHTML = html;
        } else {
            // Standard text prompt for fresh or Step 1/2 cards
            UI.promptText.innerHTML = currentQuestion.promptText;
        }

        if (!isGroupActive) {
            UI.answerInput.value = '';
            UI.answerInput.focus();
        }
    }
    
    updateCounter();
    AppState.isGrading = false;

}

async function evaluateAnswer(submittedAnswer) {
    const now = Date.now();
    if (AppState.isGrading || (now - AppState.lastSubmitTime < 300)) return;
    if (AppState.studyQueue.length === 0 && !AppState.pendingNext) return;

    // 漢字基礎１: while feedback is showing, Enter / Next moves on
    if (AppState.pendingNext) {
        AppState.lastSubmitTime = now;
        runPendingNext();
        return;
    }

    AppState.isGrading = true;
    AppState.lastSubmitTime = now;

    try {
        const currentQuestion = AppState.studyQueue[0];

        // --- ADD THIS ENTIRE BLOCK FOR READING MODE ---
        if (isReadingQuestion(currentQuestion)) {
            // Strip out punctuation so user input aligns with the base kana string
            const normalizedInput = submittedAnswer.trim().replace(/[。、？！\.\?!, ]/g, '');
            const isCorrect = (normalizedInput === currentQuestion.correctAnswerKana);

            // Class sentences: after a correct answer show the reading and English until Enter / Next
            const waitAfter = isCorrect && currentQuestion.showTranslation;
            if (waitAfter) {
                UI.promptText.innerHTML =
                    `<div lang="ja" style="font-size: 2.2rem; color: var(--accent-color); margin-bottom: 0.5rem;">${KB1Core.escapeHtml(currentQuestion.japaneseText)}</div>` +
                    `<div lang="ja" class="kb1-instruction">${KB1Core.escapeHtml(currentQuestion.readText)}</div>` +
                    `<div class="kb1-translation">${KB1Core.escapeHtml(currentQuestion.englishTranslation)}</div>`;
            }
            const goNext = () => waitAfter ? waitForNext(() => loadNextQuestion()) : setTimeout(() => loadNextQuestion(), 300);

            if (isCorrect) {
                if (currentQuestion.step === 0) {
                    // First-try success -> Graduate
                    flashElementColor(UI.answerInput, 'var(--success-color)');
                    AppState.completedCount++;
                    AppState.activeFuriganaIndex = -1;
                    AppState.studyQueue.shift();
                    
                    goNext();
                } else {
                    // Corrected with spotlight -> SRS Re-insert 3 spaces down
                    flashElementColor(UI.answerInput, 'var(--success-color)');
                    AppState.activeFuriganaIndex = -1;
                    
                    const questionToRequeue = AppState.studyQueue.shift();
                    questionToRequeue.step = 0; // Reset step so it acts fresh when they see it again
                    const initialDelay = parseInt(UI.srsInitialDelay?.value, 10) || 4;
                    const insertIndex = Math.min(initialDelay, AppState.studyQueue.length);
                    AppState.studyQueue.splice(insertIndex, 0, questionToRequeue);
                    
                    goNext();
                }
            } else {
                flashElementColor(UI.answerInput, 'var(--error-color)');
                currentQuestion.step = 1; // Mark as failed on first try
                AppState.activeFuriganaIndex = findFirstErrorComponent(normalizedInput, currentQuestion.components);
                
                loadNextQuestion(); 
                AppState.isGrading = true;
                setTimeout(() => { AppState.isGrading = false; }, 300);
            }
            return;
        }
        // --- END READING MODE BLOCK ---

        // --- 漢字基礎１: every other class question is graded the same way, then waits for Enter / Next ---
        if (AppState.currentCategory === 'kb1') {
            gradeClassQuestion(currentQuestion, submittedAnswer);
            return;
        }

        if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
            const score = calculateSimilarity(submittedAnswer, currentQuestion.correctAnswerKana);
            
            AppState.sessionResults.push({
                ...currentQuestion,
                userAnswer: submittedAnswer,
                score: score
            });

            const feedbackColor = score >= 80 ? 'var(--success-color)' : 'var(--error-color)';
            flashElementColor(UI.answerInput, feedbackColor);

            // Update Memory
            let flashMemory = [];
            try {
                flashMemory = JSON.parse(localStorage.getItem('japaneseStudyApp_FlashMemory') || '[]');
            } catch (e) {}
            
            // Remove if it exists, then add to front
            flashMemory = flashMemory.filter(id => id !== currentQuestion.wordId);
            flashMemory.unshift(currentQuestion.wordId);
            
            // Keep only 50 in memory to avoid bloated storage
            if (flashMemory.length > 50) flashMemory = flashMemory.slice(0, 50);
            localStorage.setItem('japaneseStudyApp_FlashMemory', JSON.stringify(flashMemory));

            // Move the current question to the end of the queue for endless cycling
            const currentQ = AppState.studyQueue.shift();
            AppState.studyQueue.push(currentQ);

            AppState.completedCount++;

            setTimeout(() => loadNextQuestion(), 500);
            return;
        }

        let isCorrect = false;
        let visualTarget = null; 
        
        const isGroupActive = isGroupMode();
        if (isGroupActive) {
            isCorrect = (submittedAnswer === currentQuestion.correctAnswer);
            visualTarget = UI.groupBtnsContainer;
        } else if (currentQuestion.choices) {
            // Multiple choice (class questions)
            isCorrect = (submittedAnswer === currentQuestion.correctAnswer);
            visualTarget = UI.choiceBtnsContainer;
            if (!isCorrect) markChoice(submittedAnswer, 'choice-wrong');
        } else {
            const normalizedInput = submittedAnswer.trim().toLowerCase();

            // Split the checks so we know HOW they got it right
            // (acceptAnswers: extra accepted spellings, e.g. on'yomi typed in hiragana or katakana)
            const isKanaMatch = normalizedInput === currentQuestion.correctAnswerKana || normalizedInput === currentQuestion.correctAnswerRomaji.toLowerCase()
                || (currentQuestion.acceptAnswers || []).includes(submittedAnswer.trim());
            const isExactKanjiMatch = currentQuestion.kanjiText && normalizedInput === currentQuestion.kanjiText;
            
            isCorrect = isKanaMatch || isExactKanjiMatch;
            visualTarget = UI.answerInput;
            
            // Attach flags temporarily to use in the logic below
            currentQuestion._isExactKanjiMatch = isExactKanjiMatch;
        }

        // If we are waiting for the user to type the correct word after a mistake
        if (AppState.isCorrectionMode) {
            if (isCorrect) {
                flashElementColor(visualTarget, 'var(--success-color)');
                AppState.isCorrectionMode = false;
                
                // Now that it's corrected, apply the re-insertion logic (4 spaces away)
                const questionToRequeue = AppState.studyQueue.shift();
                const requeueItem = { ...questionToRequeue, step: 1 };
                const initialDelay = parseInt(UI.srsInitialDelay?.value, 10) || 4;
                const insertIndex = Math.min(initialDelay, AppState.studyQueue.length);
                AppState.studyQueue.splice(insertIndex, 0, requeueItem);

                processCorrectAnswerVisuals(currentQuestion);
            } else {
                flashElementColor(visualTarget, 'var(--error-color)');
                setTimeout(() => { AppState.isGrading = false; }, 300);
            }
            return;
        }

        // --- NEW: KANJI DRAWING MODE EVALUATION ---
        if (AppState.isKanjiDrawingMode) {
            if (currentQuestion._isExactKanjiMatch) { 
                flashElementColor(visualTarget, 'var(--success-color)');
                AppState.isKanjiDrawingMode = false;
                
                const questionObj = AppState.studyQueue.shift();
                
                // Check if this was a delayed review or a fresh intercept
                if (questionObj.step === 'kanji_review') {
                    // They successfully reviewed the kanji. Graduate the word!
                    AppState.completedCount++;
                } else {
                    // They just intercepted it. Treat as a soft requeue for later.
                    questionObj.step = 'kanji_review'; 
                    
                    // Use the new unified SRS setting
                    const initialDelay = parseInt(UI.srsInitialDelay?.value, 10) || 4; 
                    const insertIndex = Math.min(initialDelay, AppState.studyQueue.length);
                    AppState.studyQueue.splice(insertIndex, 0, questionObj);
                }

                processCorrectAnswerVisuals(currentQuestion);
            } else {
                flashElementColor(visualTarget, 'var(--error-color)');
                setTimeout(() => { AppState.isGrading = false; }, 300);
            }
            return;
        }

        if (isCorrect) {
            const hasKanji = currentQuestion.kanjiText && /[\u4e00-\u9faf]/.test(currentQuestion.kanjiText);
            const practiceModeOn = UI.kanjiPracticeToggle && UI.kanjiPracticeToggle.checked;

            // Partial Success Intercept: They typed kana, but Practice Mode wants Kanji
            // (never for class questions: the class exam doesn't test writing kanji)
            if (practiceModeOn && hasKanji && !currentQuestion._isExactKanjiMatch && AppState.currentCategory !== 'kb1') {
                AppState.isKanjiDrawingMode = true;
                flashElementColor(visualTarget, 'var(--accent-color)'); // Blue "Info" flash

                // Fetch and show SVGs
                UI.promptText.innerHTML = `<span style="color: var(--text-secondary); font-size: 1.2rem;">Loading Stroke Order...</span>`;
                const components = await buildKanjiPracticeData(currentQuestion.kanjiText);
                
                let html = `<div class="kanji-practice-container">`;
                components.forEach(comp => {
                    if (comp.type === 'kanji') {
                        html += `<div class="kanji-svg-wrapper">${comp.svg}</div>`;
                    } else {
                        html += `<div class="kana-text-wrapper">${comp.char}</div>`;
                    }
                });
                html += `</div>`;
                html += `<div style="font-size: 1rem; color: var(--text-secondary);">${currentQuestion.promptText}</div>`;
                
                UI.promptText.innerHTML = html;
                UI.answerInput.value = '';
                UI.answerInput.focus();
                setTimeout(() => { AppState.isGrading = false; }, 300);
                return; // Stop here and wait for them to draw it
            }

            // Full Success: Graduate the word
            flashElementColor(visualTarget, 'var(--success-color)');
            const currentQuestionObj = AppState.studyQueue.shift();
            
            if (currentQuestionObj.step === 1) {
                currentQuestionObj.step = 2;
                const finalDelay = parseInt(UI.srsFinalDelay?.value, 10) || 10;
                const insertIndex = Math.min(finalDelay, AppState.studyQueue.length);
                AppState.studyQueue.splice(insertIndex, 0, currentQuestionObj);
            } else {
                AppState.completedCount++;
            }
            processCorrectAnswerVisuals(currentQuestion);
        } else {
            handleIncorrectAnswer(currentQuestion, visualTarget);
        }
    } catch (err) {
        AppState.isGrading = false;
        throw err;
    }
}

// --- 漢字基礎１: feedback, then Enter / Next ---
// Shows the result and the full answer, then waits; the queue moves on only when the user says so.
function gradeClassQuestion(question, submittedAnswer) {
    const result = KB1Core.grade(question, submittedAnswer, findWordById);
    if (AppState.exam) {                 // mock exam: no feedback, just record and move on
        AppState.exam.records.push({ q: question, answer: submittedAnswer, correct: result.correct });
        AppState.studyQueue.shift();
        AppState.completedCount++;
        loadNextQuestion();
        return;
    }
    const target = question.choices ? UI.choiceBtnsContainer : UI.answerInput;
    flashElementColor(target, result.correct ? 'var(--success-color)' : 'var(--error-color)');
    if (question.choices) {
        markChoice(question.correctAnswer, 'choice-correct');
        if (!result.correct && submittedAnswer != null) markChoice(submittedAnswer, 'choice-wrong');
    }
    UI.promptText.innerHTML += `<div class="kb1-feedback">${result.html}</div>`;
    if (!result.correct && question.readText && UI.audioToggleCheckbox.checked) speakJapanese(question.readText);
    if (result.correct && question.readText && UI.audioToggleCorrectCheckbox && UI.audioToggleCorrectCheckbox.checked) speakJapanese(question.readText);
    waitForNext(() => {
        const q = AppState.studyQueue.shift();
        if (result.correct) {
            if (q.step === 1) {          // answered right after an earlier miss: one more check later
                q.step = 2;
                const finalDelay = parseInt(UI.srsFinalDelay?.value, 10) || 10;
                AppState.studyQueue.splice(Math.min(finalDelay, AppState.studyQueue.length), 0, q);
            } else {
                AppState.completedCount++;
            }
        } else {                          // missed: comes back a few cards later
            q.step = 1;
            const initialDelay = parseInt(UI.srsInitialDelay?.value, 10) || 4;
            AppState.studyQueue.splice(Math.min(initialDelay, AppState.studyQueue.length), 0, q);
        }
        loadNextQuestion();
    });
}

// --- 漢字基礎１ mock exam ---
function startExamState(opts) {
    stopExamTimer();
    AppState.exam = null;
    if (!opts) return;
    AppState.exam = { records: [], endsAt: opts.examMinutes ? Date.now() + opts.examMinutes * 60000 : 0, timerId: null };
    if (AppState.exam.endsAt) {
        AppState.exam.timerId = setInterval(() => {
            if (!AppState.exam) return;
            if (Date.now() >= AppState.exam.endsAt) finishSession();
            else updateCounter();
        }, 1000);
    }
}

function stopExamTimer() {
    if (AppState.exam && AppState.exam.timerId) clearInterval(AppState.exam.timerId);
}

function examTimeLeft() {
    if (!AppState.exam || !AppState.exam.endsAt) return '';
    const s = Math.max(0, Math.round((AppState.exam.endsAt - Date.now()) / 1000));
    return ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showExamResults() {
    const exam = AppState.exam;
    stopExamTimer();
    // anything not reached (time ran out) counts as unanswered
    AppState.studyQueue.forEach(q => exam.records.push({ q, answer: null, correct: false }));
    AppState.studyQueue = [];
    const misses = exam.records.filter(r => !r.correct).map(r => Object.assign({}, r.q, { step: 0 }));
    const timeUp = exam.endsAt && Date.now() >= exam.endsAt;
    UI.studySection.querySelector('.study-card')?.classList.add('kb1-wide');
    UI.promptText.innerHTML = (timeUp ? '<div class="kb1-instruction">Time is up.</div>' : '') +
        KB1Core.examResultsHtml(exam.records, findWordById);
    const right = exam.records.filter(r => r.correct).length;
    UI.sessionCounter.textContent = `${right} / ${exam.records.length}`;
    AppState.exam = null;
    UI.answerInput.style.display = 'none';
    UI.submitBtn.style.display = 'none';
    UI.skipBtn.classList.add('hidden');
    if (UI.choiceBtnsContainer) UI.choiceBtnsContainer.classList.add('hidden');
    if (UI.kb1NoneBtn) UI.kb1NoneBtn.classList.add('hidden');
    UI.retakeBtn.classList.add('hidden');
    UI.revealBtn.classList.remove('hidden');
    UI.revealBtn.textContent = 'Back to Settings';
    UI.revealBtn.onclick = resetToSettings;
    if (UI.kb1PractiseBtn) {
        UI.kb1PractiseBtn.classList.toggle('hidden', misses.length === 0);
        UI.kb1PractiseBtn.textContent = `Practise my misses (${misses.length})`;
        UI.kb1PractiseBtn.onclick = () => practiseMisses(misses);
    }
}

// A normal session (feedback, Next, re-queue) with just the exam's missed questions.
function practiseMisses(misses) {
    if (UI.kb1PractiseBtn) UI.kb1PractiseBtn.classList.add('hidden');
    UI.revealBtn.onclick = null;
    AppState.initialQueue = shuffleArray(misses.map(q => Object.assign({}, q)));
    AppState.originalTotal = AppState.initialQueue.length;
    retakeSession();
}

function waitForNext(continuation) {
    AppState.pendingNext = continuation;
    AppState.isGrading = false;
    UI.submitBtn.textContent = 'Next →';
    UI.submitBtn.classList.remove('hidden');
    UI.skipBtn.classList.add('hidden');
    UI.revealBtn.classList.add('hidden');
    if (UI.kb1NoneBtn) UI.kb1NoneBtn.classList.add('hidden');
    UI.answerInput.readOnly = true;
    if (UI.choiceBtnsContainer) UI.choiceBtnsContainer.classList.add('answered');
    UI.submitBtn.focus();
}

function clearPendingNext() {
    AppState.pendingNext = null;
    UI.submitBtn.textContent = 'Submit';
    UI.skipBtn.classList.remove('hidden');
    UI.answerInput.readOnly = false;
    if (UI.choiceBtnsContainer) UI.choiceBtnsContainer.classList.remove('answered');
}

function runPendingNext() {
    const next = AppState.pendingNext;
    clearPendingNext();
    if (UI.choiceBtnsContainer) clearElementFlash(UI.choiceBtnsContainer);
    clearElementFlash(UI.answerInput);
    if (next) next();
}

// Skips the current card without marking it correct or incorrect -- no SRS
// penalty, no "completed" credit. For a bad/broken card (data error) or a
// card the user just doesn't want to see right now. Shrinks the session
// total along with the queue so "completed / total" still reaches 100%
// instead of permanently falling short by one for every skipped card.
function skipCurrentQuestion() {
    if (AppState.pendingNext) return;
    const now = Date.now();
    if (AppState.isGrading || (now - AppState.lastSubmitTime < 300)) return;
    if (AppState.studyQueue.length === 0) return;
    if (AppState.exam) {                 // mock exam: a skipped question is recorded as unanswered
        AppState.isGrading = true;
        AppState.lastSubmitTime = now;
        gradeClassQuestion(AppState.studyQueue[0], null);
        return;
    }

    AppState.isGrading = true;
    AppState.lastSubmitTime = now;

    // Clear any transient per-question state so the next card starts fresh.
    AppState.activeFuriganaIndex = -1;
    AppState.isKanjiDrawingMode = false;
    AppState.isCorrectionMode = false;
    hideStrokeOrderPopup();
    clearElementFlash(UI.answerInput);
    clearElementFlash(UI.groupBtnsContainer);
    if (UI.choiceBtnsContainer) clearElementFlash(UI.choiceBtnsContainer);

    AppState.studyQueue.shift();
    if (AppState.originalTotal > 0) AppState.originalTotal--;

    setTimeout(() => {
        AppState.isGrading = false;
        loadNextQuestion();
    }, 150);
}

// Colours one multiple-choice button by its text (class questions)
function markChoice(choiceText, className) {
    if (!UI.choiceBtnsContainer) return;
    UI.choiceBtnsContainer.querySelectorAll('.choice-btn').forEach(btn => {
        const label = btn.querySelector('.choice-label');
        if (label && label.textContent === choiceText) btn.classList.add(className);
    });
}

function processCorrectAnswerVisuals(currentQuestion) {
    let delay = 300; // Standard snappy delay

    // 1. Play Audio on Correct
    if (UI.audioToggleCorrectCheckbox && UI.audioToggleCorrectCheckbox.checked) {
        speakJapanese(currentQuestion.readText);
    }

    // 2. Quick Reveal (Kanji Flash)
    const isGroupActive = isGroupMode();
    
    // Only flash if the toggle is checked, the mode isn't "Group", and a kanji actually exists
    if (!isGroupActive && UI.kanjiRevealToggle && UI.kanjiRevealToggle.checked && currentQuestion.kanjiText) {
        UI.promptText.innerHTML = `
            <div style="font-size: 3.5rem; color: var(--accent-color); line-height: 1.2; margin-bottom: 0.5rem;">
                <ruby>${currentQuestion.kanjiText}<rt style="font-size: 1.2rem; color: var(--text-secondary);">${currentQuestion.correctAnswerKana}</rt></ruby>
            </div>
        `;
        UI.answerInput.value = ''; // Clear input early for a cleaner visual
        
        // --- DYNAMIC TIMING LOGIC ---
        // Reuse the "Flash Speed Multiplier" if it exists, otherwise default to 1.0
        const speedMultiplier = parseFloat(UI.flashSpeedNumber?.value || 1);
        // Calculate: (chars / 2.5 chars per sec) * multiplier * 1000ms, min 1000ms for readability
        const dynamicDelay = Math.max(1000, (currentQuestion.kanjiText.length / 2.5) * 1000 * speedMultiplier);
        
        delay = dynamicDelay; 
    }

    setTimeout(() => loadNextQuestion(), delay);
}

function handleIncorrectAnswer(questionToRequeue, visualTarget) {
    if (AppState.isCorrectionMode) {
        setTimeout(() => { AppState.isGrading = false; }, 300);
        return;
    }
    
    AppState.isCorrectionMode = true;
    flashElementColor(visualTarget, 'var(--error-color)');
    
    const isGroupActive = isGroupMode();
    if (isGroupActive) {
        const groupMap = { 'group1': 'Group I', 'group2': 'Group II', 'group3': 'Group III' };
        UI.promptText.innerHTML += `<br><span style="color: var(--error-color); font-size: 1rem;">Correct: ${groupMap[questionToRequeue.correctAnswer]}</span>`;
    } else if (questionToRequeue.choices) {
        // Multiple choice: highlight the right button, show reading + meaning; they then tap it to continue
        markChoice(questionToRequeue.correctAnswer, 'choice-correct');
        UI.promptText.innerHTML += `<div class="kb1-answer"><span lang="ja">${KB1Core.escapeHtml(questionToRequeue.revealText)}</span>` +
            ` = <span lang="ja">${KB1Core.escapeHtml(questionToRequeue.correctAnswerKana)}</span>` +
            ` · ${KB1Core.escapeHtml(questionToRequeue.revealMeaning || '')}</div>`;
    } else if (questionToRequeue.kb1) {
        UI.promptText.innerHTML += `<div class="kb1-answer"><span lang="ja">${KB1Core.escapeHtml(questionToRequeue.correctAnswerKana)}</span>` +
            ` · ${KB1Core.escapeHtml(questionToRequeue.revealMeaning || '')}</div>`;
        UI.answerInput.value = '';
    } else {
        // Find the original word object to get kanji
        const originalWord = findWordById(questionToRequeue.wordId);
        let displayKanji = '';
        if (originalWord) {
            let targetForm;
            if (questionToRequeue.formKey === 'base') {
                targetForm = originalWord.base;
            } else if (originalWord.forms && originalWord.forms[questionToRequeue.formKey]) {
                targetForm = originalWord.forms[questionToRequeue.formKey];
            }

            if (targetForm && targetForm.kanji) {
                displayKanji = ` (${targetForm.kanji})`;
            }
        }
        UI.promptText.innerHTML += `<br><span style="color: var(--accent-color); font-size: 1.2rem;">${questionToRequeue.correctAnswerKana}${displayKanji}</span>`;
        UI.answerInput.value = '';
    }
    
    if (!isGroupActive && UI.audioToggleCheckbox.checked && AppState.currentStudyMode !== 'flash') {
        speakJapanese(questionToRequeue.readText);
    }

    setTimeout(() => { AppState.isGrading = false; }, 300);
}

// --- UTILITIES ---

// --- KANJIVG UTILITIES ---

// Checks if a character is a Kanji and returns its 5-digit hex code (KanjiVG format). Kanji Unicode Range: \u4e00-\u9faf
function getKanjiHex(char) {
    if (/[\u4e00-\u9faf]/.test(char)) {
        // Convert to hex and pad with leading zeros to ensure 5 digits
        return ('00000' + char.charCodeAt(0).toString(16)).slice(-5);
    }
    return null;
}

// In-memory cache of hex code -> SVG string (or null for a confirmed miss),
// so repeatedly hovering/clicking the same kanji (e.g. while reading a
// sentence) doesn't re-fetch it from GitHub every time.
const kanjiSvgCache = {};

// Fetches the raw SVG string from the KanjiVG GitHub repository.
async function fetchKanjiVG(hexCode) {
    if (Object.prototype.hasOwnProperty.call(kanjiSvgCache, hexCode)) {
        return kanjiSvgCache[hexCode];
    }

    const url = `https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji/${hexCode}.svg`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Kanji SVG not found for hex: ${hexCode}`);

        const rawText = await response.text();

        // Strip XML/DOCTYPE headers by matching strictly from <svg to </svg>
        const svgMatch = rawText.match(/<svg[\s\S]*<\/svg>/i);
        const svg = svgMatch ? svgMatch[0] : rawText;
        kanjiSvgCache[hexCode] = svg;
        return svg;

    } catch (error) {
        console.warn('KanjiVG Fetch Error:', error);
        kanjiSvgCache[hexCode] = null;
        return null;
    }
}

// Parses a Japanese word and builds an array of components (SVGs for kanji, text for kana).
async function buildKanjiPracticeData(wordText) {
    if (!wordText) return [];
    
    const components = [];
    for (const char of wordText) {
        const hex = getKanjiHex(char);
        if (hex) {
            const svgData = await fetchKanjiVG(hex);
            components.push({ type: 'kanji', char: char, svg: svgData });
        } else {
            components.push({ type: 'kana', char: char });
        }
    }
    return components;
}

// --- CLICK-TO-PRACTICE STROKE ORDER POPUP (Reading Mode) ---
// Lets a user click any kanji-containing word in a reading-mode sentence
// (standard or Dev Sandbox -- both render through renderReadingSentence)
// to pop up that word's stroke order diagrams above the hover-translation,
// so they can copy it with pen and paper without losing their place.

const strokeOrderPopupEls = {
    popup: document.getElementById('stroke-order-popup'),
    content: document.getElementById('stroke-order-content'),
    caption: document.getElementById('stroke-order-caption'),
    closeBtn: document.getElementById('stroke-order-close'),
};

let activeStrokeWordEl = null;   // the .hover-word span currently showing its popup
let strokeRequestToken = 0;      // guards against a stale async fetch overwriting a newer click

function hideStrokeOrderPopup() {
    if (!strokeOrderPopupEls.popup) return;
    strokeOrderPopupEls.popup.classList.add('hidden');
    if (activeStrokeWordEl) {
        activeStrokeWordEl.classList.remove('stroke-active');
        activeStrokeWordEl = null;
    }
}

function positionStrokeOrderPopup(anchorEl) {
    const popup = strokeOrderPopupEls.popup;
    if (!popup || !anchorEl) return;

    const anchorRect = anchorEl.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const margin = 10;

    // Center over the word, clamped so it never runs off-screen horizontally.
    let left = anchorRect.left + (anchorRect.width / 2) - (popupRect.width / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - popupRect.width - margin));

    // Prefer sitting above the word (clearing its translation tooltip space);
    // if there isn't room, place it below the word instead.
    let top = anchorRect.top - popupRect.height - 14;
    if (top < margin) {
        top = anchorRect.bottom + 14;
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
}

async function showStrokeOrderPopup(wordEl) {
    const popup = strokeOrderPopupEls.popup;
    if (!popup) return;

    const wordText = wordEl.dataset.word || '';
    const wordReading = wordEl.dataset.reading || '';

    // Clicking the already-open word again just closes it (toggle).
    if (activeStrokeWordEl === wordEl && !popup.classList.contains('hidden')) {
        hideStrokeOrderPopup();
        return;
    }

    if (activeStrokeWordEl) activeStrokeWordEl.classList.remove('stroke-active');
    activeStrokeWordEl = wordEl;
    wordEl.classList.add('stroke-active');

    const myToken = ++strokeRequestToken;

    strokeOrderPopupEls.content.innerHTML = `<div class="stroke-order-loading">Loading stroke order...</div>`;
    strokeOrderPopupEls.caption.textContent = wordReading ? `${wordText} (${wordReading})` : wordText;
    popup.classList.remove('hidden');
    positionStrokeOrderPopup(wordEl);

    const components = await buildKanjiPracticeData(wordText);

    // If the user clicked a different word (or closed it) while this was
    // in flight, drop the result rather than render it into a stale popup.
    if (myToken !== strokeRequestToken) return;

    const kanjiComponents = components.filter(c => c.type === 'kanji');

    if (kanjiComponents.length === 0) {
        strokeOrderPopupEls.content.innerHTML = `<div class="stroke-order-loading">No kanji found in this word.</div>`;
    } else {
        strokeOrderPopupEls.content.innerHTML = kanjiComponents.map(comp => {
            const svg = comp.svg || `<div class="stroke-order-loading">?</div>`;
            return `<div class="kanji-svg-wrapper">${svg}</div>`;
        }).join('');
    }

    positionStrokeOrderPopup(wordEl);
}

// Event delegation: works for any .hover-word.has-kanji rendered anywhere
// (standard sentence reading and Dev Sandbox reading both share this markup).
document.addEventListener('click', (e) => {
    const wordEl = e.target.closest('.hover-word.has-kanji');
    if (wordEl) {
        showStrokeOrderPopup(wordEl);
        return;
    }
    // Click outside the popup and outside any clickable word closes it.
    if (activeStrokeWordEl && !e.target.closest('.stroke-order-popup')) {
        hideStrokeOrderPopup();
    }
});

if (strokeOrderPopupEls.closeBtn) {
    strokeOrderPopupEls.closeBtn.addEventListener('click', hideStrokeOrderPopup);
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideStrokeOrderPopup();
});

// Keep the popup correctly anchored on resize/scroll instead of closing it --
// the whole point is that it stays put while the user copies it on paper.
window.addEventListener('resize', () => {
    if (activeStrokeWordEl) positionStrokeOrderPopup(activeStrokeWordEl);
});
window.addEventListener('scroll', () => {
    if (activeStrokeWordEl) positionStrokeOrderPopup(activeStrokeWordEl);
}, { capture: true, passive: true });

function updateSentenceHistory(start, end) {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('japaneseStudyApp_ReadingHistory') || '[]');
    } catch (e) {}

    const subsetsStudied = end ? Array.from({length: end - start + 1}, (_, i) => start + i) : [start];
    
    subsetsStudied.forEach(subset => {
        // Prevent consecutive duplicates in the history
        if (history[history.length - 1] !== subset) {
            history.push(subset);
        }
    });

    // Cap array at maximum of 5 items
    if (history.length > 5) history = history.slice(-5);

    localStorage.setItem('japaneseStudyApp_ReadingHistory', JSON.stringify(history));
    renderSentenceHistory();
}

function renderSentenceHistory() {
    if (!UI.sentenceHistoryIndicator) return;
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('japaneseStudyApp_ReadingHistory') || '[]');
    } catch (e) {}

    if (history.length === 0) {
        UI.sentenceHistoryIndicator.innerHTML = `Recently studied: None`;
    } else {
        UI.sentenceHistoryIndicator.innerHTML = `Recently studied: ${history.join(', ')}`;
    }
}

function updateDevSentenceHistory(start, end) {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('japaneseStudyApp_DevReadingHistory') || '[]');
    } catch (e) {}

    const subsetsStudied = end ? Array.from({length: end - start + 1}, (_, i) => start + i) : [start];
    
    subsetsStudied.forEach(subset => {
        if (history[history.length - 1] !== subset) {
            history.push(subset);
        }
    });

    if (history.length > 5) history = history.slice(-5);

    localStorage.setItem('japaneseStudyApp_DevReadingHistory', JSON.stringify(history));
    renderDevSentenceHistory();
}

function renderDevSentenceHistory() {
    if (!UI.devHistoryIndicator) return;
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem('japaneseStudyApp_DevReadingHistory') || '[]');
    } catch (e) {}

    if (history.length === 0) {
        UI.devHistoryIndicator.innerHTML = `Recently studied: None`;
    } else {
        UI.devHistoryIndicator.innerHTML = `Recently studied: ${history.join(', ')}`;
    }
}

function renderDevSentenceMasterList() {
    const container = document.getElementById('master-list-dev-sentences');
    if (!container || !AppState.devSubsets) return;

    const html = [];
    for (let i = 1; i <= AppState.devSubsets.length; i++) {
        const isChecked = AppState.devMasteredSubsets.has(i.toString());
        html.push(`
            <label class="checkbox-label active-option">
                <input type="checkbox" class="dev-mastered-subset-toggle" value="${i}" ${isChecked ? 'checked' : ''}>
                <span class="custom-checkbox"></span>
                Subset ${i}
            </label>
        `);
    }
    container.innerHTML = html.join('');
}

function speakJapanese(text) {
    if (!text) return;
    window.speechSynthesis.cancel(); // Stop any current speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    window.speechSynthesis.speak(utterance);
}


// Calculates string similarity using Levenshtein Distance, Returns a percentage from 0 to 100

function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    
    const m = s1.length;
    const n = s2.length;
    const d = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;

    for (let j = 1; j <= n; j++) {
        for (let i = 1; i <= m; i++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            d[i][j] = Math.min(
                d[i - 1][j] + 1,      // deletion
                d[i][j - 1] + 1,      // insertion
                d[i - 1][j - 1] + cost // substitution
            );
        }
    }
    
    const maxLength = Math.max(m, n);
    return ((maxLength - d[m][n]) / maxLength) * 100;
}

function updateCounter() {
    UI.sessionCounter.textContent = `${AppState.completedCount} / ${AppState.originalTotal}${examTimeLeft()}`;
}

function finishSession() {
    clearPendingNext();
    if (AppState.exam) {
        AppState.isGrading = false;
        clearElementFlash(UI.answerInput);
        showExamResults();
        return;
    }
    if (UI.kb1NoneBtn) UI.kb1NoneBtn.classList.add('hidden');
    if (AppState.flashTimer) {
        clearTimeout(AppState.flashTimer);
        AppState.flashTimer = null;
    }

    AppState.isGrading = false;
    clearElementFlash(UI.answerInput);
    clearElementFlash(UI.groupBtnsContainer);

    if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
        const totalScore = AppState.sessionResults.reduce((sum, res) => sum + res.score, 0);
        const averageScore = AppState.sessionResults.length > 0 ? (totalScore / AppState.sessionResults.length).toFixed(1) : 0;
        UI.promptText.innerHTML = `Session Complete! <br><span style="color: var(--accent-color);">Average Accuracy: ${averageScore}%</span>`;
        
        // Show total completed for endless mode
        UI.sessionCounter.textContent = `${AppState.completedCount} Completed`;
        
        // Hide the retake button for endless flash mode
        UI.retakeBtn.classList.add('hidden');
    } else {
        UI.promptText.innerHTML = `Session Complete! <span>Great job!</span>`;
        // Show standard ratio for fixed modes
        UI.sessionCounter.textContent = `${AppState.originalTotal} / ${AppState.originalTotal}`;
        
        // --- NEW: Show the retake button for standard modes ---
        UI.retakeBtn.classList.remove('hidden');
    }

    UI.answerInput.style.display = 'none';
    UI.submitBtn.style.display = 'none';
    UI.groupBtnsContainer.style.display = 'none';
    if (UI.choiceBtnsContainer) UI.choiceBtnsContainer.classList.add('hidden');
    UI.revealBtn.textContent = 'Back to Settings';
    
    UI.revealBtn.onclick = resetToSettings;
}

function retakeSession() {
    clearPendingNext();
    UI.studySection.querySelector('.study-card')?.classList.remove('kb1-wide');
    if (UI.kb1PractiseBtn) UI.kb1PractiseBtn.classList.add('hidden');
    AppState.studyQueue = [...AppState.initialQueue];
    AppState.studyQueue.forEach(q => { if (q.kb1) q.step = 0; });
    AppState.completedCount = 0;
    AppState.isCorrectionMode = false;
    AppState.isKanjiDrawingMode = false;
    AppState.activeFuriganaIndex = -1;
    AppState.isGrading = false;
    AppState.lastSubmitTime = 0;
    
    clearElementFlash(UI.answerInput);
    clearElementFlash(UI.groupBtnsContainer);

    // Reset the inline styles applied during the finished state
    UI.answerInput.style.display = '';
    UI.submitBtn.style.display = '';
    UI.groupBtnsContainer.style.display = '';
    if (UI.choiceBtnsContainer) { clearElementFlash(UI.choiceBtnsContainer); UI.choiceBtnsContainer.classList.add('hidden'); }
    UI.answerInput.classList.remove('hidden');
    UI.submitBtn.classList.remove('hidden');
    UI.revealBtn.textContent = (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') ? 'End Session' : 'Reveal';
    
    UI.revealBtn.onclick = null;
    UI.retakeBtn.classList.add('hidden');
    
    toggleUIInputs();
    loadNextQuestion();
}

function resetToSettings() {
    clearPendingNext();
    UI.studySection.querySelector('.study-card')?.classList.remove('kb1-wide');
    stopExamTimer();
    AppState.exam = null;
    if (UI.kb1PractiseBtn) UI.kb1PractiseBtn.classList.add('hidden');
    if (UI.kb1NoneBtn) UI.kb1NoneBtn.classList.add('hidden');
    window.speechSynthesis.cancel(); // Stop any currently playing audio
    
    AppState.studyQueue = [];
    AppState.completedCount = 0;
    AppState.isCorrectionMode = false;
    AppState.isKanjiDrawingMode = false;
    AppState.activeFuriganaIndex = -1;
    AppState.isGrading = false;
    AppState.lastSubmitTime = 0;
    
    clearElementFlash(UI.answerInput);
    clearElementFlash(UI.groupBtnsContainer);

    UI.answerInput.style.display = '';
    UI.submitBtn.style.display = '';
    UI.groupBtnsContainer.style.display = '';
    if (UI.choiceBtnsContainer) { clearElementFlash(UI.choiceBtnsContainer); UI.choiceBtnsContainer.classList.add('hidden'); }
    UI.answerInput.classList.remove('hidden');
    UI.submitBtn.classList.remove('hidden');
    UI.answerInput.value = '';
    UI.revealBtn.textContent = 'Reveal';
    
    UI.revealBtn.onclick = null;
    UI.retakeBtn.classList.add('hidden');
    
    UI.studySection.classList.add('hidden');
    UI.settingsSection.classList.remove('hidden');
    
    updateLiveEstimator();
}

// Map tracking active flash timers and true baseline border styles per element
const activeFlashes = new WeakMap();

function isKnownFlashColor(color) {
    if (!color) return false;
    return (
        color === 'var(--error-color)' ||
        color === 'var(--success-color)' ||
        color === 'var(--accent-color)' ||
        color.includes('239, 68, 68') ||
        color.includes('16, 185, 129') ||
        color.includes('92, 138, 255')
    );
}

function clearElementFlash(element) {
    if (!element) return;
    const flashInfo = activeFlashes.get(element);
    if (flashInfo) {
        clearTimeout(flashInfo.timerId);
        element.style.borderColor = flashInfo.originalBorderColor;
        element.style.borderWidth = flashInfo.originalBorderWidth;
        element.style.borderStyle = flashInfo.originalBorderStyle;
        if (element === UI.groupBtnsContainer && !flashInfo.originalBorderStyle) {
            element.style.borderStyle = 'none';
        }
        activeFlashes.delete(element);
    } else {
        const currentBorder = element.style.borderColor;
        if (isKnownFlashColor(currentBorder)) {
            element.style.borderColor = '';
            element.style.borderWidth = '';
            element.style.borderStyle = (element === UI.groupBtnsContainer) ? 'none' : '';
        }
    }
}

function flashElementColor(element, color, duration = 400) {
    if (!element) return;

    let flashInfo = activeFlashes.get(element);

    if (flashInfo) {
        // Clear pending revert timeout so multiple rapid calls do not prematurely reset or overwrite styles
        clearTimeout(flashInfo.timerId);
    } else {
        // Record baseline styles. If the element currently has a flash color, baseline must be clean ''
        const currentBorderColor = element.style.borderColor;
        flashInfo = {
            originalBorderColor: isKnownFlashColor(currentBorderColor) ? '' : currentBorderColor,
            originalBorderStyle: element.style.borderStyle,
            originalBorderWidth: element.style.borderWidth
        };
    }

    element.style.borderColor = color;
    element.style.borderWidth = '2px';
    element.style.borderStyle = 'solid';

    flashInfo.timerId = setTimeout(() => {
        element.style.borderColor = flashInfo.originalBorderColor;
        element.style.borderWidth = flashInfo.originalBorderWidth;
        element.style.borderStyle = flashInfo.originalBorderStyle;
        if (element === UI.groupBtnsContainer && !flashInfo.originalBorderStyle) {
            element.style.borderStyle = 'none';
        }
        activeFlashes.delete(element);
    }, duration);

    activeFlashes.set(element, flashInfo);
}

// Some sentence data tokenizes punctuation (、。？！, etc.) as its own
// component, e.g. { word_text: "、", word_reading: "、" }. The reading the
// user types has ALL punctuation stripped before comparison (see
// evaluateAnswer), so a non-empty reading of just "、" can never actually be
// typed -- it must never consume a cursor position or be reportable as "the"
// error, or it incorrectly flags the comma itself as a mistake regardless of
// where the user's real typo (if any) is.
function isPunctuationOnlyText(text) {
    return !!text && /^[。、？！\.\?!,]+$/.test(text);
}

// Evaluates the user's input against the chunked components to find the error point.
function findFirstErrorComponent(userInput, components) {
    let cursor = 0;

    for (let i = 0; i < components.length; i++) {
        const comp = components[i];
        const expectedReading = comp.word_reading;

        if (!expectedReading) continue; // Safety check for empty readings
        if (isPunctuationOnlyText(comp.word_text)) continue; // Never a real "word" to get wrong

        if (userInput[cursor] === '-') return i;

        const inputChunk = userInput.substring(cursor, cursor + expectedReading.length);
        if (inputChunk !== expectedReading) return i;

        cursor += expectedReading.length;
    }
    return -1;
}

//Renders the sentence by mapping components onto the full base text.
//Preserves original punctuation and injects hoverable dictionary tooltips.

function renderReadingSentence(japaneseText, components, activeIndex) {
    let result = '';
    let remainingText = japaneseText || '';

    if (!components || components.length === 0) return japaneseText;

    components.forEach((comp, i) => {
        const wordIndex = remainingText.indexOf(comp.word_text);
        
        if (wordIndex !== -1) {
            // Append any skipped characters (like punctuation) before the component
            result += remainingText.substring(0, wordIndex);

            // Some sentence data tokenizes punctuation as its own component
            // (e.g. "、" with word_reading "、"). It's not a real word -- don't
            // make it hoverable/clickable, and never give it a furigana hint
            // (findFirstErrorComponent already skips it when picking activeIndex,
            // but guard here too in case activeIndex ever points at it directly).
            if (isPunctuationOnlyText(comp.word_text)) {
                result += comp.word_text;
                remainingText = remainingText.substring(wordIndex + comp.word_text.length);
                return;
            }

            // Determine tooltip translation:
            // 1. Prioritize pre-embedded comp.english_meaning if present.
            // 2. If comp.english_meaning is an empty string or undefined (such as for punctuation or particles), keep blank.
            // 3. Fallback to dictionary lookup only as a safety net if english_meaning is missing entirely.
            let translation = "";
            if (typeof comp.english_meaning !== 'undefined') {
                translation = comp.english_meaning ? comp.english_meaning.trim() : "";
            } else {
                const isLikelyParticle = comp.type === "Particle" || (comp.word_text.length === 1 && !/[\u4E00-\u9FAF]/.test(comp.word_text));
                if (!isLikelyParticle) {
                    translation = getWordTranslation(comp.word_text, comp.word_reading) || "";
                }
            }

            const safeTranslation = translation ? translation.replace(/"/g, '&quot;') : "";
            const safeWord = comp.word_text.replace(/"/g, '&quot;');
            const safeReading = (comp.word_reading || '').replace(/"/g, '&quot;');
            const hasKanji = /[一-龯]/.test(comp.word_text);

            // Build the wrapper with the tooltip data attribute, plus the
            // data needed to look up stroke order on click for kanji words.
            let wordHtml = `<span class="hover-word${hasKanji ? ' has-kanji' : ''}" data-translation="${safeTranslation}" data-word="${safeWord}" data-reading="${safeReading}">`;

            // Append the target component, adding Furigana if it's the active index
            if (i === activeIndex && comp.word_reading) {
                wordHtml += `<ruby>${comp.word_text}<rt>${comp.word_reading}</rt></ruby>`;
            } else {
                wordHtml += comp.word_text;
            }
            
            wordHtml += `</span>`;
            result += wordHtml;

            // Slice off the processed portion to move the cursor forward
            remainingText = remainingText.substring(wordIndex + comp.word_text.length);
        }
    });

    // Append any trailing text (like the final period '。')
    result += remainingText;
    
    return result;
}


// A word by id: the app's vocabulary, then the unlocked class vocabulary (same format).
function findWordById(id) {
    return AppState.omniDatabase.find(word => word.id === id) || (window.KB1 ? window.KB1.findWord(id) : null);
}

// Helper function to find an exact string match in the base or explicit forms.

function findExactMatch(text, reading) {
    if (!text && !reading) return null;

    // 1. Try to find a direct match on the base form
    let match = AppState.omniDatabase.find(w => 
        (w.base.kanji && w.base.kanji === text) || 
        (w.base.kana === text) || 
        (w.base.kana === reading)
    );
    if (match) return match;

    // 2. Try the explicit conjugated forms (masu, te, ta, nai, negative, etc.)
    return AppState.omniDatabase.find(w => {
        if (!w.forms) return false;
        return Object.values(w.forms).some(form => 
            (form.kanji && form.kanji === text) || 
            (form.kana === text) ||
            (form.kana === reading)
        );
    });
}

// Scans the OmniDatabase for a matching kanji or kana string and returns the English meaning. Includes fuzzy suffix matching to catch advanced conjugations (e.g. ました -> ます).
function getWordTranslation(text, reading) {
    if (!AppState.omniDatabase) return "";

    // Step 1: Check for an exact match first
    let match = findExactMatch(text, reading);
    if (match) return match.meaning;

    // Step 2: Fuzzy Suffix Matching
    // Map long conversational suffixes back to the standard forms stored in data.json
    const suffixMap = [
        // Masu-stem conjugations -> revert to 'ます' (masu)
        { endings: ['ませんでした', 'ません', 'ました', 'ましょう', 'たいん', 'たい'], replaceWith: 'ます' },
        // Te-form continuous/trials -> revert to 'て' (te)
        { endings: ['ています', 'ている', 'てみて'], replaceWith: 'て' },
        // Ta-form conditionals -> revert to 'た' (ta)
        { endings: ['たら'], replaceWith: 'た' },
        // Adjective polite negative -> revert to 'くない' (negative)
        { endings: ['くありません'], replaceWith: 'くない' },
        // Adjective adverbial -> revert to 'い' (base)
        { endings: ['く'], replaceWith: 'い' },
        // Na-adjective noun modifier -> revert to base (remove 'な')
        { endings: ['な'], replaceWith: '' },
        // 'Seems like' (sou) for i-adjectives -> revert to 'い'
        { endings: ['そう'], replaceWith: 'い' }
    ];

    for (let rule of suffixMap) {
        for (let ending of rule.endings) {
            // Check if the current word ends with one of the target suffixes
            if (text.endsWith(ending) || (reading && reading.endsWith(ending))) {
                
                // Strip the ending and swap it with the known form
                const fuzzyText = text.endsWith(ending) 
                    ? text.slice(0, -ending.length) + rule.replaceWith 
                    : text;
                    
                const fuzzyReading = (reading && reading.endsWith(ending)) 
                    ? reading.slice(0, -ending.length) + rule.replaceWith 
                    : reading;
                
                // Search the database again using the simplified string
                match = findExactMatch(fuzzyText, fuzzyReading);
                if (match) return match.meaning;
            }
        }
    }

    return "";
}

// --- STATE PERSISTENCE ---

function saveSettings() {
    const checkboxes = UI.settingsSection.querySelectorAll('input[type="checkbox"]');
    const settingsState = {};
    
    checkboxes.forEach((cb, index) => {
        const key = cb.id || cb.dataset.groupTarget || cb.dataset.formTarget || cb.dataset.jlptTarget || `cb_${index}`;
        settingsState[key] = cb.checked;
    });

    // Save both verb and sentence modes
    const activeVerbRadio = UI.settingsSection.querySelector('input[name="verb-study-mode"]:checked');
    if (activeVerbRadio) settingsState['verb-study-mode'] = activeVerbRadio.value;

    const activeSentenceRadio = UI.settingsSection.querySelector('input[name="sentence-study-mode"]:checked');
    if (activeSentenceRadio) settingsState['sentence-study-mode'] = activeSentenceRadio.value;

    const activeKb1Mode = UI.settingsSection.querySelector('input[name="kb1-mode"]:checked');
    if (activeKb1Mode) settingsState['kb1-mode'] = activeKb1Mode.value;
    ['kb1-exam-count', 'kb1-exam-minutes'].forEach(id => {
        const el = document.getElementById(id);
        if (el) settingsState[id] = el.value;
    });

    const activeSubsetMode = UI.settingsSection.querySelector('input[name="subset-mode"]:checked');
    if (activeSubsetMode) settingsState['subset-mode'] = activeSubsetMode.value;
    
    settingsState['sentenceSubsetStart'] = UI.sentenceSubsetStart.value;
    settingsState['sentenceSubsetEnd'] = UI.sentenceSubsetEnd.value;

    const activeDevSubsetMode = UI.settingsSection.querySelector('input[name="dev-subset-mode"]:checked');
    if (activeDevSubsetMode) settingsState['dev-subset-mode'] = activeDevSubsetMode.value;

    if (UI.devSubsetStart) settingsState['devSubsetStart'] = UI.devSubsetStart.value;
    if (UI.devSubsetEnd) settingsState['devSubsetEnd'] = UI.devSubsetEnd.value;

    // Save the new SRS inputs
    if (UI.srsInitialDelay) settingsState['srsInitialDelay'] = UI.srsInitialDelay.value;
    if (UI.srsFinalDelay) settingsState['srsFinalDelay'] = UI.srsFinalDelay.value;

    localStorage.setItem('japaneseStudyApp_Settings', JSON.stringify(settingsState));
}

function loadSettings() {
    let settingsState = null;
    try {
        const savedData = localStorage.getItem('japaneseStudyApp_Settings');
        if (savedData) settingsState = JSON.parse(savedData);
    } catch (error) {
        console.warn('Failed to parse settings from localStorage during loadSettings.', error);
    }

    if (settingsState) {
        // Load static checkboxes first
        const staticCheckboxes = UI.settingsSection.querySelectorAll('input[type="checkbox"]:not([data-subset-index])');
        
        staticCheckboxes.forEach((cb, index) => {
            const key = cb.id || cb.dataset.groupTarget || cb.dataset.formTarget || cb.dataset.jlptTarget || `cb_${index}`;
            if (settingsState[key] !== undefined && !cb.disabled) {
                cb.checked = settingsState[key];
            }
        });

        // Restore radio states properly
        if (settingsState['verb-study-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="verb-study-mode"][value="${settingsState['verb-study-mode']}"]`);
            if (radio) radio.checked = true;
        }
        if (settingsState['sentence-study-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="sentence-study-mode"][value="${settingsState['sentence-study-mode']}"]`);
            if (radio) radio.checked = true;
        }
        ['kb1-exam-count', 'kb1-exam-minutes'].forEach(id => {
            const el = document.getElementById(id);
            if (el && settingsState[id]) el.value = settingsState[id];
        });
        if (settingsState['kb1-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="kb1-mode"][value="${settingsState['kb1-mode']}"]`);
            if (radio) radio.checked = true;
        }
        if (settingsState['subset-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="subset-mode"][value="${settingsState['subset-mode']}"]`);
            if (radio) {
                radio.checked = true;
                UI.sentenceSubsetEndWrapper.classList.toggle('hidden', radio.value === 'single');
            }
        }
        if (settingsState['dev-subset-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="dev-subset-mode"][value="${settingsState['dev-subset-mode']}"]`);
            if (radio) {
                radio.checked = true;
                const isSingle = radio.value === 'single';
                if (UI.devSubsetTo) UI.devSubsetTo.classList.toggle('hidden', isSingle);
                if (UI.devSubsetEnd) UI.devSubsetEnd.classList.toggle('hidden', isSingle);
            }
        }

        // Initialize the study mode based on whatever tab is currently active
        if (AppState.currentCategory === 'sentence') {
            AppState.currentStudyMode = UI.settingsSection.querySelector('input[name="sentence-study-mode"]:checked')?.value || 'reading';
        } else if (AppState.currentCategory === 'verb') {
            AppState.currentStudyMode = UI.settingsSection.querySelector('input[name="verb-study-mode"]:checked')?.value || 'translation';
        } else if (AppState.currentCategory === 'dev') {
            AppState.currentStudyMode = 'reading';
        } else if (AppState.currentCategory === 'kb1') {
            AppState.currentStudyMode = UI.settingsSection.querySelector('input[name="kb1-mode"]:checked')?.value || 'kb1-reading-typed';
        }
        
        if (settingsState['sentenceSubsetStart']) UI.sentenceSubsetStart.value = settingsState['sentenceSubsetStart'];
        if (settingsState['sentenceSubsetEnd']) UI.sentenceSubsetEnd.value = settingsState['sentenceSubsetEnd'];
        if (settingsState['devSubsetStart'] && UI.devSubsetStart) UI.devSubsetStart.value = settingsState['devSubsetStart'];
        if (settingsState['devSubsetEnd'] && UI.devSubsetEnd) UI.devSubsetEnd.value = settingsState['devSubsetEnd'];
        
        // Load the new SRS inputs
        if (settingsState['srsInitialDelay'] && UI.srsInitialDelay) UI.srsInitialDelay.value = settingsState['srsInitialDelay'];
        if (settingsState['srsFinalDelay'] && UI.srsFinalDelay) UI.srsFinalDelay.value = settingsState['srsFinalDelay'];

        updateModeUI();
    }
}

// --- DEV TAB CRYPTO & UNLOCK ---

function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

// Fetches an encrypted JSON file ({salt, nonce, ciphertext}, base64) and decrypts it with the password:
// PBKDF2-SHA256 (iterations stored in the file, default 100,000) -> AES-256-GCM. Throws on a wrong password.
// Used by the Dev and 漢字基礎１ tabs.
async function decryptEncFile(url, password) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
        throw new Error(`Failed to fetch ${url} (${resp.status})`);
    }

    const encData = await resp.json();
    const { salt, nonce, ciphertext } = encData;

    if (!salt || !nonce || !ciphertext) {
        throw new Error("Invalid encrypted file format.");
    }

    const saltBytes = base64ToUint8Array(salt);
    const nonceBytes = base64ToUint8Array(nonce);
    const cipherBytes = base64ToUint8Array(ciphertext);

    // 1. Import password as raw key material for PBKDF2
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    // 2. Derive 256-bit AES-GCM key using PBKDF2 (SHA-256). Newer files store their iteration
    //    count; older ones (sentences_dev.enc) used 100,000.
    const aesKey = await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: saltBytes,
            iterations: Number(encData.iterations) || 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    // 3. Decrypt ciphertext using AES-GCM with nonce
    const decryptedBuffer = await window.crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: nonceBytes
        },
        aesKey,
        cipherBytes
    );

    return JSON.parse(new TextDecoder().decode(decryptedBuffer));
}

async function decryptDevData(password) {
    if (!password) {
        if (UI.devPasswordInput) flashElementColor(UI.devPasswordInput, 'var(--error-color)');
        if (UI.devErrorMsg) UI.devErrorMsg.textContent = 'Please enter a password';
        return;
    }

    if (UI.devErrorMsg) UI.devErrorMsg.textContent = '';
    if (UI.devUnlockBtn) {
        UI.devUnlockBtn.disabled = true;
        UI.devUnlockBtn.textContent = 'Unlocking...';
    }

    try {
        const parsedData = await decryptEncFile('sentences_dev.enc', password);

        AppState.devSentenceDatabase = parsedData;
        AppState.isDevUnlocked = true;

        // Chunk devSentenceDatabase into an array of subsets of 9 sequential sentences (41 subsets of 9 + 1 remainder subset of 3 = 42 subsets)
        const devSubsets = [];
        for (let i = 0; i < AppState.devSentenceDatabase.length; i += 9) {
            devSubsets.push(AppState.devSentenceDatabase.slice(i, i + 9));
        }
        AppState.devSubsets = devSubsets;

        // Populate Mastered Subsets checklist
        renderDevSentenceMasterList();

        // Render dev reading history
        renderDevSentenceHistory();

        if (UI.devLockView) UI.devLockView.classList.add('hidden');
        if (UI.devSettingsView) UI.devSettingsView.classList.remove('hidden');
        if (UI.devErrorMsg) UI.devErrorMsg.textContent = '';
        if (UI.devPasswordInput) UI.devPasswordInput.value = '';

        updateLiveEstimator();

    } catch (err) {
        console.warn("Dev decryption failed:", err);
        if (UI.devPasswordInput) {
            flashElementColor(UI.devPasswordInput, 'var(--error-color)');
            UI.devPasswordInput.focus();
        }
        if (UI.devErrorMsg) {
            UI.devErrorMsg.textContent = 'Incorrect password';
        }
    } finally {
        if (UI.devUnlockBtn) {
            UI.devUnlockBtn.disabled = false;
            UI.devUnlockBtn.textContent = 'Unlock';
        }
    }
}

// --- EVENT LISTENERS ---

UI.startBtn.addEventListener('click', initializeSession);
UI.closeSessionBtn.addEventListener('click', resetToSettings);

UI.submitBtn.addEventListener('click', () => {
    evaluateAnswer(UI.answerInput.value);
});

if (UI.skipBtn) {
    UI.skipBtn.addEventListener('click', skipCurrentQuestion);
}

// Multiple-choice buttons (class questions): click, or press 1-4
if (UI.choiceBtnsContainer) {
    UI.choiceBtnsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.choice-btn');
        if (!btn) return;
        const label = btn.querySelector('.choice-label');
        evaluateAnswer(label ? label.textContent : '');
    });
}
document.addEventListener('keydown', (e) => {
    if (AppState.pendingNext && e.key === 'Enter' && e.target !== UI.answerInput && !UI.studySection.classList.contains('hidden')) {
        e.preventDefault();
        evaluateAnswer('');
        return;
    }
    if (AppState.pendingNext) return;
    if (!UI.choiceBtnsContainer || UI.choiceBtnsContainer.classList.contains('hidden')) return;
    if (UI.studySection.classList.contains('hidden') || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    const btns = UI.choiceBtnsContainer.querySelectorAll('.choice-btn');
    if (n >= 1 && n <= btns.length) { e.preventDefault(); btns[n - 1].click(); }
});

if (UI.kb1NoneBtn) UI.kb1NoneBtn.addEventListener('click', () => evaluateAnswer('なし'));

UI.groupChoiceBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        evaluateAnswer(e.target.dataset.answer);
    });
});

UI.retakeBtn.addEventListener('click', retakeSession);

UI.sentenceSubsetStart.addEventListener('input', () => { saveSettings(); updateLiveEstimator(); });
UI.sentenceSubsetEnd.addEventListener('input', () => { saveSettings(); updateLiveEstimator(); });

if (UI.devSubsetStart) {
    UI.devSubsetStart.addEventListener('input', () => { saveSettings(); updateLiveEstimator(); });
}
if (UI.devSubsetEnd) {
    UI.devSubsetEnd.addEventListener('input', () => { saveSettings(); updateLiveEstimator(); });
}
if (UI.devSubsetSingle) {
    UI.devSubsetSingle.addEventListener('change', () => {
        if (UI.devSubsetTo) UI.devSubsetTo.classList.add('hidden');
        if (UI.devSubsetEnd) UI.devSubsetEnd.classList.add('hidden');
        saveSettings();
        updateLiveEstimator();
    });
}
if (UI.devSubsetRange) {
    UI.devSubsetRange.addEventListener('change', () => {
        if (UI.devSubsetTo) UI.devSubsetTo.classList.remove('hidden');
        if (UI.devSubsetEnd) UI.devSubsetEnd.classList.remove('hidden');
        saveSettings();
        updateLiveEstimator();
    });
}

UI.flashSpeedSlider.addEventListener('input', () => {
    UI.flashSpeedNumber.value = UI.flashSpeedSlider.value;
});

UI.flashSpeedNumber.addEventListener('input', () => {
    UI.flashSpeedSlider.value = UI.flashSpeedNumber.value;
});

UI.flashLengthSlider.addEventListener('input', () => {
    UI.flashLengthNumber.value = UI.flashLengthSlider.value;
});

UI.flashLengthNumber.addEventListener('input', () => {
    UI.flashLengthSlider.value = UI.flashLengthNumber.value;
});

// Toggle the Kanji Handwriting Keyboard Instructions
if (UI.kanjiInfoIcon) {
    UI.kanjiInfoIcon.addEventListener('click', () => {
        UI.kanjiTipBox.classList.toggle('hidden');
    });
}

UI.srsInitialDelay.addEventListener('input', saveSettings);
UI.srsFinalDelay.addEventListener('input', saveSettings);

UI.revealBtn.addEventListener('click', () => {
    // Prevent the reveal logic from firing if we are clicking "Back to Settings"
    if (UI.revealBtn.textContent === 'Back to Settings') return;

    if ((AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') && UI.revealBtn.textContent === 'End Session') {
        finishSession();
        return;
    }

    if (AppState.currentCategory === 'kb1' && !isReadingQuestion(AppState.studyQueue[0])) {
        if (AppState.isGrading || AppState.pendingNext || AppState.exam || AppState.studyQueue.length === 0) return;
        AppState.isGrading = true;
        gradeClassQuestion(AppState.studyQueue[0], null);
        return;
    }

    if (AppState.studyQueue.length > 0) {
        if (AppState.isGrading) return;
        const isGroupActive = isGroupMode();
        const visualTarget = isGroupActive ? UI.groupBtnsContainer
            : (AppState.studyQueue[0].choices ? UI.choiceBtnsContainer : UI.answerInput);
        AppState.isGrading = true;
        handleIncorrectAnswer(AppState.studyQueue[0], visualTarget);
    }
});

UI.answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        evaluateAnswer(UI.answerInput.value);
    }
});

UI.settingsSection.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
        // --- NEW: Kanji Options Mutual Exclusivity ---
        if (e.target.id === 'kanji-practice-toggle' && e.target.checked) {
            if (UI.kanjiRevealToggle) {
                UI.kanjiRevealToggle.checked = false;
            }
        }
        if (e.target.id === 'kanji-reveal-toggle' && e.target.checked) {
            if (UI.kanjiPracticeToggle) {
                UI.kanjiPracticeToggle.checked = false;
            }
        }
        // Handle Verb Study Mode Radios
        if (e.target.name === 'verb-study-mode') {
            AppState.currentStudyMode = e.target.value;
            updateModeUI();
        }

        // Handle 漢字基礎１ Study Mode Radios
        if (e.target.name === 'kb1-mode') {
            AppState.currentStudyMode = e.target.value;
            updateModeUI();
        }

        // Handle Sentence Study Mode Radios
        if (e.target.name === 'sentence-study-mode') {
            AppState.currentStudyMode = e.target.value;
            updateModeUI();
        }

        // Handle Subset Mode Toggle (Single vs Range)
        if (e.target.name === 'subset-mode') {
            UI.sentenceSubsetEndWrapper.classList.toggle('hidden', e.target.value === 'single');
            saveSettings();
            updateLiveEstimator();
            return;
        }

        // Handle Dev Subset Mode Toggle (Single vs Range)
        if (e.target.name === 'dev-subset-mode') {
            const isSingle = e.target.value === 'single';
            if (UI.devSubsetTo) UI.devSubsetTo.classList.toggle('hidden', isSingle);
            if (UI.devSubsetEnd) UI.devSubsetEnd.classList.toggle('hidden', isSingle);
            saveSettings();
            updateLiveEstimator();
            return;
        }

        // Handle Conjugation Form Radios Exclusivity
        if (e.target.name === 'given-form' || e.target.name === 'target-form') {
            const givenRadio = UI.settingsSection.querySelector('input[name="given-form"]:checked');
            const targetRadio = UI.settingsSection.querySelector('input[name="target-form"]:checked');

            if (givenRadio && targetRadio && givenRadio.value === targetRadio.value) {
                // If they matched, we pick a different one for the group that was NOT just clicked
                const otherName = e.target.name === 'given-form' ? 'target-form' : 'given-form';
                const options = ['base', 'masu', 'te', 'ta', 'nai'];
                const currentIndex = options.indexOf(e.target.value);
                const nextIndex = (currentIndex + 1) % options.length;
                const nextValue = options[nextIndex];
                
                const nextRadio = UI.settingsSection.querySelector(`input[name="${otherName}"][value="${nextValue}"]`);
                if (nextRadio) nextRadio.checked = true;
            }
        }

        // Handle Known Word Toggles
        if (e.target.type === 'checkbox' && e.target.classList.contains('known-word-toggle')) {
            if (e.target.checked) {
                AppState.knownWords.add(e.target.value);
            } else {
                AppState.knownWords.delete(e.target.value);
            }
            saveKnownWords();
            updateLiveEstimator();
            return;
        }

        // Handle Mastered Subset Toggles
        if (e.target.type === 'checkbox' && e.target.classList.contains('mastered-subset-toggle')) {
            if (e.target.checked) {
                AppState.masteredSubsets.add(e.target.value);
            } else {
                AppState.masteredSubsets.delete(e.target.value);
            }
            saveMasteredSubsets();
            updateLiveEstimator();
            return;
        }

        // Handle Dev Mastered Subset Toggles
        if (e.target.type === 'checkbox' && e.target.classList.contains('dev-mastered-subset-toggle')) {
            if (e.target.checked) {
                AppState.devMasteredSubsets.add(e.target.value);
            } else {
                AppState.devMasteredSubsets.delete(e.target.value);
            }
            saveDevMasteredSubsets();
            updateLiveEstimator();
            return;
        }

        // Check if this change requires re-calculating subsets
        const isParentFilter = e.target.dataset.jlptTarget || 
                               e.target.dataset.groupTarget || 
                               e.target.dataset.adjGroup || 
                               e.target.dataset.nounGroup || 
                               e.target.name === 'verb-study-mode';

        if (isParentFilter) {
            renderSubsetCheckboxes();
        }

        // Always save state and update estimator for any other checkbox change (like subsets)
        saveSettings();
        updateLiveEstimator();
        updateModeUI();
    }
});

UI.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const tabKey = btn.dataset.tab.replace('tab-', '');
        const category = (tabKey === 'dev' || tabKey === 'kb1') ? tabKey : tabKey.slice(0, -1);
        switchTab(category);
    });
});

if (UI.devUnlockBtn) {
    UI.devUnlockBtn.addEventListener('click', () => {
        decryptDevData(UI.devPasswordInput?.value || '');
    });
}

if (UI.devPasswordInput) {
    UI.devPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            decryptDevData(UI.devPasswordInput.value);
        }
    });
}

UI.bulkActionBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetGroup = e.target.dataset.targetGroup;
        const action = e.target.dataset.action;
        const isChecked = action === 'all';
        
        let targetCheckboxes;
        
        if (targetGroup === 'verb-groups') {
            targetCheckboxes = UI.groupCheckboxes;
        } else if (targetGroup === 'verb-forms') {
            targetCheckboxes = UI.formCheckboxes;
        } else if (targetGroup === 'noun-groups') {
            targetCheckboxes = document.querySelectorAll('[data-noun-group]');
        } else if (targetGroup === 'subsets') {
            // Re-query as these are dynamic
            targetCheckboxes = document.querySelectorAll('[data-subset-index]');
        } else if (targetGroup === 'kb1-steps') {
            targetCheckboxes = document.querySelectorAll('[data-kb1-step]');
        } else if (targetGroup === 'flash-subsets') {
            targetCheckboxes = document.querySelectorAll('[data-sentence-subset-index]');
        }
        
        if (targetCheckboxes) {
            targetCheckboxes.forEach(cb => {
                if (!cb.disabled) cb.checked = isChecked;
            });
        }
        
        if (targetGroup === 'verb-groups' || targetGroup === 'noun-groups') {
            renderSubsetCheckboxes();
        }
        
        saveSettings();
        updateLiveEstimator();
    });
});


// --- INITIALIZATION ---

async function initApp() {
    try {
        const [respVocab, respSentences] = await Promise.all([
            fetch('data.json'),
            fetch('sentence_data.json')
        ]);

        if (!respVocab.ok || !respSentences.ok) {
            throw new Error("Failed to fetch database files.");
        }

        AppState.omniDatabase = await respVocab.json();
        AppState.sentenceDatabase = await respSentences.json();

        // Group sentences by ID prefix (e.g., "1_1", "1_2" -> group "1")
        const groupsMap = {};
        AppState.sentenceDatabase.forEach(s => {
            const gid = s.id.split('_')[0];
            if (!groupsMap[gid]) groupsMap[gid] = [];
            groupsMap[gid].push(s);
        });
        // Apply seeded shuffle to the 330 groups
        AppState.sentenceGroups = seededShuffle(Object.values(groupsMap), 12345);

        // 1. Restore static setting states
        loadSettings();
        // 2. Generate subsets based on static settings & restore subset states
        renderSubsetCheckboxes();
        // 2.5 Render Sentence History
        renderSentenceHistory();
        renderDevSentenceHistory();
        // 3. Update estimator based on full loaded state
        updateLiveEstimator();
        // 4. Initialize WanaKana text conversion
        wanakana.bind(UI.answerInput, { IMEMode: true });
        // 5. Render the master exclusion lists
        renderMasterLists();
        // 6. Render the sentence subset exclusion list
        renderSentenceMasterList();
        // 7. 漢字基礎１ tab (unlock + settings)
        if (window.KB1) window.KB1.init({
            decryptEncFile, flashElementColor, updateLiveEstimator, renderMasterList, saveSettings,
            knownIds: () => Array.from(AppState.knownWords)
        });
    } catch (error) {
        console.error('Failed to initialize application:', error);
    }
}

initApp();

})();