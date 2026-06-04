(function() {
    "use strict";

// --- PRNG & PREDICTABLE SHUFFLE ---

/**
 * A basic Linear Congruential Generator (LCG) for predictable random numbers
 */
function createPRNG(seed) {
    return function() {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
    }
}

/**
 * Deterministically shuffles an array using the provided seed.
 * Ensures the vocabulary chunks remain identical across reloads.
 */
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
    activeFuriganaIndex: -1
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

function saveKnownWords() {
    localStorage.setItem('japaneseStudyApp_KnownWords', JSON.stringify(Array.from(AppState.knownWords)));
}

function saveMasteredSubsets() {
    localStorage.setItem('japaneseStudyApp_MasteredSubsets', JSON.stringify(Array.from(AppState.masteredSubsets)));
}

// --- DOM ELEMENTS ---
const UI = {
    settingsSection: document.getElementById('settings-section'),
    estimatorText: document.getElementById('live-estimator'),
    studySection: document.getElementById('study-section'),
    startBtn: document.getElementById('start-btn'),
    submitBtn: document.getElementById('submit-btn'),
    revealBtn: document.getElementById('reveal-btn'),
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
    bulkActionBtns: document.querySelectorAll('.bulk-action-btn')
};

// --- CORE ENGINE: SPACED REPETITION ---

/**
 * Standard Fisher-Yates Shuffle Algorithm for the active study queue
 */
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Manages the visibility of setting sections based on the selected study mode.
 */
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
        const isFlashOrListening = AppState.currentCategory === 'sentence' && (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening');
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
            lengthGroup.classList.toggle('hidden', AppState.currentStudyMode === 'reading');
        }
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
    }

    const targetId = `tab-${category}s`;

    // Update active class on the tab buttons
    UI.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === targetId);
    });

    // Toggle visibility of content wrappers
    [UI.tabVerbs, UI.tabAdjectives, UI.tabNouns, UI.tabSentences].forEach(panel => {
        if (panel) panel.classList.toggle('hidden', panel.id !== targetId);
    });

    // Toggle visibility of specific settings groups for the Sentences tab
    const isSentence = category === 'sentence';
    [UI.jlptSettingsGroup, UI.subsetSettingsGroup, UI.audioSettingsGroup].forEach(group => {
        if (group) group.classList.toggle('hidden', isSentence);
    });

    // Refresh the UI state for the selected category
    renderSubsetCheckboxes();
    updateModeUI();
    saveSettings();
    updateLiveEstimator();
}


 // Renders the master vocabulary lists for all categories to allow word exclusion.
 
function renderMasterLists() {
    const verbContainer = document.getElementById('master-list-verbs');
    const adjContainer = document.getElementById('master-list-adjectives');
    const nounContainer = document.getElementById('master-list-nouns');

    const sections = [
        { el: verbContainer, type: 'verb' },
        { el: adjContainer, type: 'adjective' },
        { el: nounContainer, type: 'noun' }
    ];

    // 1. Setup Containers with Filter Inputs
    sections.forEach(section => {
        if (!section.el) return;
        section.el.innerHTML = `
            <div style="grid-column: 1 / -1; margin-bottom: 1rem; width: 100%; display: flex; flex-direction: column; gap: 0.5rem;">
                <input type="text" class="answer-input master-list-filter" 
                       placeholder="Filter ${section.type}s by word or meaning..." 
                       style="text-align: left; font-size: 1rem; padding: 0.6rem 1rem;">
                <label class="checkbox-label kana-toggle-label" style="font-size: 0.85rem; color: var(--text-secondary); width: fit-content;">
                    <input type="checkbox" class="kana-toggle" checked>
                    <span class="custom-checkbox" style="width: 16px; height: 16px;"></span>
                    Use Kana Input
                </label>
            </div>
        `;
    });

    const verbHtml = [];
    const adjHtml = [];
    const nounHtml = [];

    AppState.omniDatabase.forEach(word => {
        const isChecked = AppState.knownWords.has(word.id);
        const html = `
            <label class="checkbox-label active-option">
                <input type="checkbox" class="known-word-toggle" value="${word.id}" ${isChecked ? 'checked' : ''}>
                <span class="custom-checkbox"></span>
                ${word.base.kana} (${word.meaning})
            </label>
        `;

        if (word.type === 'verb') verbHtml.push(html);
        else if (word.type === 'adjective') adjHtml.push(html);
        else if (word.type === 'noun') nounHtml.push(html);
    });

    if (verbContainer) verbContainer.insertAdjacentHTML('beforeend', verbHtml.join(''));
    if (adjContainer) adjContainer.insertAdjacentHTML('beforeend', adjHtml.join(''));
    if (nounContainer) nounContainer.insertAdjacentHTML('beforeend', nounHtml.join(''));

    // 2. Initialize Filtering Logic
    document.querySelectorAll('.master-list-filter').forEach(filterInput => {
        const kanaToggle = filterInput.parentElement.querySelector('.kana-toggle');

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
            const parentGrid = e.target.closest('.checkbox-grid');
            const labels = parentGrid.querySelectorAll('.checkbox-label:not(.kana-toggle-label)');

            labels.forEach(label => {
                const isMatch = label.textContent.toLowerCase().includes(term);
                label.classList.toggle('hidden', !isMatch);
            });
        });
    });
}

/**
 * Renders the 110 Sentence Subsets into the exclusion master list.
 */
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

/**
 * Dynamically builds the subset checkboxes based on active JLPT and Verb Group filters.
 */
function renderSubsetCheckboxes() {
    if (!AppState.omniDatabase) return;

    // Handle Sentences category transition
    if (AppState.currentCategory === 'sentence') {
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

/**
 * Helper to retrieve the active chunked vocabulary list based on all filters.
 */
function getFilteredAndChunkedVocab() {
    if (!AppState.omniDatabase) return [];

    if (AppState.currentCategory === 'sentence') {
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
    const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
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


// Parses settings, filters omniDatabase, and builds the study queue.

function initializeSession() {
    const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
    const isConjugationActive = AppState.currentStudyMode === 'conjugation' && AppState.currentCategory === 'verb';
    const filteredVocab = getFilteredAndChunkedVocab();
    let rawQuestions = [];

    // --- NEW SENTENCE GATHERING LOGIC ---
    if (AppState.currentCategory === 'sentence') {
        
        if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
            // --- ENDLESS FLASH / LISTENING LOGIC ---
            let sentences = [...AppState.sentenceDatabase];
            
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
            rawQuestions = sentences.map(item => {
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
                return shuffledGroup.map(item => {
                    return {
                        type: 'sentence',
                        wordId: item.id,
                        flashContent: item.japanese_reading,
                        components: item.components, // ADD THIS: Pass components down
                        japaneseText: item.japanese_text, // ADD THIS: Pass base text
                        promptText: AppState.currentStudyMode === 'reading' 
                            ? 'Type the kana reading. Use "-" to skip a word.' 
                            : 'Type the sentence you saw:',
                        correctAnswerKana: item.japanese_reading.replace(/[。、？！\.\?!, ]/g, ''),
                        correctAnswerRomaji: '___NO_ROMAJI___',
                        readText: item.japanese_reading,
                        step: 0
                    };
                });
            });
        }
    } else if (isGroupActive) {
        // --- MODE 1: Verb Group Identification ---
        filteredVocab.forEach(word => {
            const exceptionMarker = word.isException ? ' ⚠️' : '';
            rawQuestions.push({
                wordId: word.id,
                formKey: 'base', 
                promptText: `Identify Group: <span>${word.base.kana} (${word.meaning})${exceptionMarker}</span>`,
                correctAnswer: word.subType,
                step: 0
            });
        });
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
                step: 0
            });
        });
    } else if (AppState.currentCategory === 'noun') {
        // --- MODE 3: Noun Translation ---
        filteredVocab.forEach(word => {
            rawQuestions.push({
                wordId: word.id,
                formKey: 'base',
                promptText: `Translate: <span>${word.meaning}</span>`,
                correctAnswerKana: word.base.kana,
                correctAnswerRomaji: word.base.romaji,
                readText: word.base.kana,
                step: 0
            });
        });
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

    UI.settingsSection.classList.add('hidden');
    UI.studySection.classList.remove('hidden');
    
    if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
        UI.revealBtn.textContent = 'End Session';
    }

    toggleUIInputs();
    loadNextQuestion();
}

function toggleUIInputs() {
    const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
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

function loadNextQuestion() {
    if (AppState.studyQueue.length === 0) {
        finishSession();
        return;
    }

    const currentQuestion = AppState.studyQueue[0];
    
    // --- ADD THIS NEW BLOCK FOR READING MODE ---
    if (AppState.currentCategory === 'sentence' && AppState.currentStudyMode === 'reading') {
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
    else if (AppState.currentCategory === 'sentence' && (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening')) {
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
        UI.promptText.innerHTML = currentQuestion.promptText;
        const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
        if (!isGroupActive) {
            UI.answerInput.value = '';
            UI.answerInput.focus();
        }
    }
    
    updateCounter();
}

function evaluateAnswer(submittedAnswer) {
    if (AppState.studyQueue.length === 0) return;

    const currentQuestion = AppState.studyQueue[0];

    // --- ADD THIS ENTIRE BLOCK FOR READING MODE ---
    if (AppState.currentCategory === 'sentence' && AppState.currentStudyMode === 'reading') {
        // Strip out punctuation so user input aligns with the base kana string
        const normalizedInput = submittedAnswer.trim().replace(/[。、？！\.\?!, ]/g, ''); 
        const isCorrect = (normalizedInput === currentQuestion.correctAnswerKana);

        if (isCorrect) {
            if (currentQuestion.step === 0) {
                // First-try success -> Graduate
                flashElementColor(UI.answerInput, 'var(--success-color)');
                AppState.completedCount++;
                AppState.activeFuriganaIndex = -1;
                AppState.studyQueue.shift();
                
                setTimeout(() => loadNextQuestion(), 300);
            } else {
                // Corrected with spotlight -> SRS Re-insert 3 spaces down
                flashElementColor(UI.answerInput, 'var(--success-color)');
                AppState.activeFuriganaIndex = -1;
                
                const questionToRequeue = AppState.studyQueue.shift();
                questionToRequeue.step = 0; // Reset step so it acts fresh when they see it again
                const insertIndex = Math.min(3, AppState.studyQueue.length);
                AppState.studyQueue.splice(insertIndex, 0, questionToRequeue);
                
                setTimeout(() => loadNextQuestion(), 300);
            }
        } else {
            flashElementColor(UI.answerInput, 'var(--error-color)');
            currentQuestion.step = 1; // Mark as failed on first try
            AppState.activeFuriganaIndex = findFirstErrorComponent(normalizedInput, currentQuestion.components);
            
            loadNextQuestion(); 
        }
        return;
    }
    // --- END READING MODE BLOCK ---

    if (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') {
        const score = calculateSimilarity(submittedAnswer, currentQuestion.correctAnswerKana);
        
        AppState.sessionResults.push({
            ...currentQuestion,
            userAnswer: submittedAnswer,
            score: score
        });

        const feedbackColor = score >= 80 ? 'var(--success-color)' : 'var(--error-color)';
        flashElementColor(UI.answerInput, feedbackColor);

        // --- NEW: Update Memory ---
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
    
    const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
    if (isGroupActive) {
        isCorrect = (submittedAnswer === currentQuestion.correctAnswer);
        visualTarget = UI.groupBtnsContainer; 
    } else {
        const normalizedInput = submittedAnswer.trim().toLowerCase();
        isCorrect = 
            normalizedInput === currentQuestion.correctAnswerKana || 
            normalizedInput === currentQuestion.correctAnswerRomaji.toLowerCase();
        visualTarget = UI.answerInput;
    }

    // If we are waiting for the user to type the correct word after a mistake
    if (AppState.isCorrectionMode) {
        if (isCorrect) {
            flashElementColor(visualTarget, 'var(--success-color)');
            AppState.isCorrectionMode = false;
            
            // Now that it's corrected, apply the re-insertion logic (4 spaces away)
            const questionToRequeue = AppState.studyQueue.shift();
            const requeueItem = { ...questionToRequeue, step: 1 };
            const insertIndex = Math.min(4, AppState.studyQueue.length);
            AppState.studyQueue.splice(insertIndex, 0, requeueItem);

            setTimeout(() => loadNextQuestion(), 300);
        } else {
            flashElementColor(visualTarget, 'var(--error-color)');
        }
        return;
    }

    if (isCorrect) {
        flashElementColor(visualTarget, 'var(--success-color)');
        const currentQuestionObj = AppState.studyQueue.shift();
        
        if (currentQuestionObj.step === 1) {
            // Previously missed word: move to step 2 and re-insert 10 positions away
            currentQuestionObj.step = 2;
            const insertIndex = Math.min(10, AppState.studyQueue.length);
            AppState.studyQueue.splice(insertIndex, 0, currentQuestionObj);
        } else {
            // step 0 (fresh) or step 2 (final review): graduate
            AppState.completedCount++;
        }
        setTimeout(() => loadNextQuestion(), 300);
    } else {
        handleIncorrectAnswer(currentQuestion, visualTarget);
    }
}

function handleIncorrectAnswer(questionToRequeue, visualTarget) {
    if (AppState.isCorrectionMode) return;
    
    AppState.isCorrectionMode = true;
    flashElementColor(visualTarget, 'var(--error-color)');
    
    const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
    if (isGroupActive) {
        const groupMap = { 'group1': 'Group I', 'group2': 'Group II', 'group3': 'Group III' };
        UI.promptText.innerHTML += `<br><span style="color: var(--error-color); font-size: 1rem;">Correct: ${groupMap[questionToRequeue.correctAnswer]}</span>`;
    } else {
        // Find the original word object to get kanji
        const originalWord = AppState.omniDatabase.find(word => word.id === questionToRequeue.wordId);
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
}

// --- UTILITIES ---

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
    UI.sessionCounter.textContent = `${AppState.completedCount} / ${AppState.originalTotal}`;
}

function finishSession() {
    if (AppState.flashTimer) {
        clearTimeout(AppState.flashTimer);
        AppState.flashTimer = null;
    }

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
    UI.revealBtn.textContent = 'Back to Settings';
    
    UI.revealBtn.onclick = resetToSettings;
}

function retakeSession() {
    AppState.studyQueue = [...AppState.initialQueue];
    AppState.completedCount = 0;
    AppState.isCorrectionMode = false;
    AppState.activeFuriganaIndex = -1;
    
    // Reset the inline styles applied during the finished state
    UI.answerInput.style.display = '';
    UI.submitBtn.style.display = '';
    UI.groupBtnsContainer.style.display = '';
    UI.revealBtn.textContent = (AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') ? 'End Session' : 'Reveal';
    
    UI.revealBtn.onclick = null;
    UI.retakeBtn.classList.add('hidden');
    
    toggleUIInputs();
    loadNextQuestion();
}

function resetToSettings() {
    window.speechSynthesis.cancel(); // Stop any currently playing audio
    
    AppState.studyQueue = [];
    AppState.completedCount = 0;
    AppState.isCorrectionMode = false;
    AppState.activeFuriganaIndex = -1;
    
    UI.answerInput.style.display = '';
    UI.submitBtn.style.display = '';
    UI.groupBtnsContainer.style.display = '';
    UI.answerInput.value = '';
    UI.revealBtn.textContent = 'Reveal';
    
    UI.revealBtn.onclick = null;
    UI.retakeBtn.classList.add('hidden');
    
    UI.studySection.classList.add('hidden');
    UI.settingsSection.classList.remove('hidden');
    
    updateLiveEstimator();
}

function flashElementColor(element, color) {
    const originalBorder = element.style.borderColor;
    element.style.borderColor = color;
    element.style.borderWidth = '2px';
    element.style.borderStyle = 'solid';
    
    setTimeout(() => {
        element.style.borderColor = originalBorder;
        if(element === UI.groupBtnsContainer) element.style.borderStyle = 'none';
    }, 400);
}

/**
 * Evaluates the user's input against the chunked components to find the error point.
 */
function findFirstErrorComponent(userInput, components) {
    let cursor = 0;

    for (let i = 0; i < components.length; i++) {
        const comp = components[i];
        const expectedReading = comp.word_reading;

        if (!expectedReading) continue; // Safety check for empty readings

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

            // --- DICTIONARY LOOKUP WORKAROUND ---
            // Only lookup translation if it's not a tiny particle (length > 1 or specific kanji)
            // This saves computation and prevents common kana like "は" or "が" from showing weird tooltips
            let translation = "";
            const isLikelyParticle = comp.type === "Particle" || (comp.word_text.length === 1 && !/[\u4E00-\u9FAF]/.test(comp.word_text));
            
            if (!isLikelyParticle) {
                translation = getWordTranslation(comp.word_text, comp.word_reading);
            }

            // Build the wrapper with the tooltip data attribute
            let wordHtml = `<span class="hover-word" data-translation="${translation}">`;

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

/**
 * Scans the OmniDatabase for a matching kanji or kana string and returns the English meaning.
 * Includes fuzzy suffix matching to catch advanced conjugations (e.g. ました -> ます).
 */
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

    // UPDATE THIS BLOCK to save both verb and sentence modes
    const activeVerbRadio = UI.settingsSection.querySelector('input[name="verb-study-mode"]:checked');
    if (activeVerbRadio) settingsState['verb-study-mode'] = activeVerbRadio.value;

    const activeSentenceRadio = UI.settingsSection.querySelector('input[name="sentence-study-mode"]:checked');
    if (activeSentenceRadio) settingsState['sentence-study-mode'] = activeSentenceRadio.value;

    const activeSubsetMode = UI.settingsSection.querySelector('input[name="subset-mode"]:checked');
    if (activeSubsetMode) settingsState['subset-mode'] = activeSubsetMode.value;
    
    settingsState['sentenceSubsetStart'] = UI.sentenceSubsetStart.value;
    settingsState['sentenceSubsetEnd'] = UI.sentenceSubsetEnd.value;

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

        // UPDATE THIS BLOCK to restore radio states properly
        if (settingsState['verb-study-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="verb-study-mode"][value="${settingsState['verb-study-mode']}"]`);
            if (radio) radio.checked = true;
        }
        if (settingsState['sentence-study-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="sentence-study-mode"][value="${settingsState['sentence-study-mode']}"]`);
            if (radio) radio.checked = true;
        }
        if (settingsState['subset-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="subset-mode"][value="${settingsState['subset-mode']}"]`);
            if (radio) {
                radio.checked = true;
                UI.sentenceSubsetEndWrapper.classList.toggle('hidden', radio.value === 'single');
            }
        }

        // Initialize the study mode based on whatever tab is currently active
        if (AppState.currentCategory === 'sentence') {
            AppState.currentStudyMode = UI.settingsSection.querySelector('input[name="sentence-study-mode"]:checked')?.value || 'reading';
        } else if (AppState.currentCategory === 'verb') {
            AppState.currentStudyMode = UI.settingsSection.querySelector('input[name="verb-study-mode"]:checked')?.value || 'translation';
        }
        
        if (settingsState['sentenceSubsetStart']) UI.sentenceSubsetStart.value = settingsState['sentenceSubsetStart'];
        if (settingsState['sentenceSubsetEnd']) UI.sentenceSubsetEnd.value = settingsState['sentenceSubsetEnd'];

        updateModeUI();
    }
}

// --- EVENT LISTENERS ---

UI.startBtn.addEventListener('click', initializeSession);
UI.closeSessionBtn.addEventListener('click', resetToSettings);

UI.submitBtn.addEventListener('click', () => {
    evaluateAnswer(UI.answerInput.value);
});

UI.groupChoiceBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        evaluateAnswer(e.target.dataset.answer);
    });
});

UI.retakeBtn.addEventListener('click', retakeSession);

UI.sentenceSubsetStart.addEventListener('input', () => { saveSettings(); updateLiveEstimator(); });
UI.sentenceSubsetEnd.addEventListener('input', () => { saveSettings(); updateLiveEstimator(); });

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

UI.revealBtn.addEventListener('click', () => {
    // Prevent the reveal logic from firing if we are clicking "Back to Settings"
    if (UI.revealBtn.textContent === 'Back to Settings') return;

    if ((AppState.currentStudyMode === 'flash' || AppState.currentStudyMode === 'listening') && UI.revealBtn.textContent === 'End Session') {
        finishSession();
        return;
    }

    if (AppState.studyQueue.length > 0) {
        const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
        const visualTarget = isGroupActive ? UI.groupBtnsContainer : UI.answerInput;
        handleIncorrectAnswer(AppState.studyQueue[0], visualTarget);
    }
});

UI.answerInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        evaluateAnswer(UI.answerInput.value);
    }
});

UI.settingsSection.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
        // Handle Verb Study Mode Radios
        if (e.target.name === 'verb-study-mode') {
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
    }
});

UI.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const category = btn.dataset.tab.replace('tab-', '').slice(0, -1);
        switchTab(category);
    });
});

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
        // 3. Update estimator based on full loaded state
        updateLiveEstimator();
        // 4. Initialize WanaKana text conversion
        wanakana.bind(UI.answerInput, { IMEMode: true });
        // 5. Render the master exclusion lists
        renderMasterLists();
        // 6. Render the sentence subset exclusion list
        renderSentenceMasterList();
    } catch (error) {
        console.error('Failed to initialize application:', error);
    }
}

initApp();

})();