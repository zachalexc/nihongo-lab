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
    studyQueue: [],
    originalTotal: 0,
    completedCount: 0,
    currentStudyMode: 'translation',
    initialQueue: [],
    currentCategory: 'verb',
    knownWords: new Set(),
    isCorrectionMode: false
};

// Restore persistent state for known words
try {
    AppState.knownWords = new Set(JSON.parse(localStorage.getItem('japaneseStudyApp_KnownWords') || '[]'));
} catch (error) {
    console.warn('Failed to parse known words from localStorage. Resetting to empty.', error);
    AppState.knownWords = new Set();
}

/**
 * Saves the current state of known words to localStorage.
 */
function saveKnownWords() {
    localStorage.setItem('japaneseStudyApp_KnownWords', JSON.stringify(Array.from(AppState.knownWords)));
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
}

/**
 * Handles switching between study categories (Verbs, Adjectives, Nouns).
 */
function switchTab(category) {
    AppState.currentCategory = category;
    const targetId = `tab-${category}s`;

    // Update active class on the tab buttons
    UI.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === targetId);
    });

    // Toggle visibility of content wrappers
    [UI.tabVerbs, UI.tabAdjectives, UI.tabNouns].forEach(panel => {
        panel.classList.toggle('hidden', panel.id !== targetId);
    });

    // Refresh the UI state for the selected category
    renderSubsetCheckboxes();
    updateModeUI();
    saveSettings();
    updateLiveEstimator();
}

/**
 * Renders the master vocabulary lists for all categories to allow word exclusion.
 */
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
 * Dynamically builds the subset checkboxes based on active JLPT and Verb Group filters.
 */
function renderSubsetCheckboxes() {
    if (!AppState.omniDatabase) return;

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

/**
 * Calculates the expected number of flashcards based on current settings.
 */
function updateLiveEstimator() {
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

/**
 * Parses settings, filters omniDatabase, and builds the study queue.
 */
function initializeSession() {
    const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
    const isConjugationActive = AppState.currentStudyMode === 'conjugation' && AppState.currentCategory === 'verb';
    const filteredVocab = getFilteredAndChunkedVocab();
    let rawQuestions = [];

    if (isGroupActive) {
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

    // Standard randomize for the active study queue
    AppState.studyQueue = shuffleArray(rawQuestions);
    AppState.initialQueue = [...AppState.studyQueue]; // Cache the shuffled queue for retakes
    AppState.originalTotal = AppState.studyQueue.length;
    AppState.completedCount = 0;

    UI.settingsSection.classList.add('hidden');
    UI.studySection.classList.remove('hidden');
    
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
    UI.promptText.innerHTML = currentQuestion.promptText;
    
    const isGroupActive = AppState.currentStudyMode === 'group' && AppState.currentCategory === 'verb';
    if (!isGroupActive) {
        UI.answerInput.value = '';
        UI.answerInput.focus();
    }
    
    updateCounter();
}

function evaluateAnswer(submittedAnswer) {
    if (AppState.studyQueue.length === 0) return;

    const currentQuestion = AppState.studyQueue[0];
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
    
    if (!isGroupActive && UI.audioToggleCheckbox.checked) {
        speakJapanese(questionToRequeue.readText);
    }
}

// --- UTILITIES ---

function speakJapanese(text) {
    if (!text) return;
    window.speechSynthesis.cancel(); // Stop any current speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    window.speechSynthesis.speak(utterance);
}

function updateCounter() {
    UI.sessionCounter.textContent = `${AppState.completedCount} / ${AppState.originalTotal}`;
}

function finishSession() {
    UI.promptText.innerHTML = `Session Complete! <span>Great job!</span>`;
    UI.answerInput.style.display = 'none';
    UI.submitBtn.style.display = 'none';
    UI.groupBtnsContainer.style.display = 'none';
    UI.revealBtn.textContent = 'Back to Settings';
    UI.sessionCounter.textContent = `${AppState.originalTotal} / ${AppState.originalTotal}`;
    
    UI.revealBtn.onclick = resetToSettings;
    UI.retakeBtn.classList.remove('hidden');
}

function retakeSession() {
    AppState.studyQueue = [...AppState.initialQueue];
    AppState.completedCount = 0;
    AppState.isCorrectionMode = false;
    
    // Reset the inline styles applied during the finished state
    UI.answerInput.style.display = '';
    UI.submitBtn.style.display = '';
    UI.groupBtnsContainer.style.display = '';
    UI.revealBtn.textContent = 'Reveal / Skip';
    
    UI.revealBtn.onclick = null;
    UI.retakeBtn.classList.add('hidden');
    
    toggleUIInputs();
    loadNextQuestion();
}

function resetToSettings() {
    AppState.studyQueue = [];
    AppState.completedCount = 0;
    AppState.isCorrectionMode = false;
    
    UI.answerInput.style.display = '';
    UI.submitBtn.style.display = '';
    UI.groupBtnsContainer.style.display = '';
    UI.answerInput.value = '';
    UI.revealBtn.textContent = 'Reveal / Skip';
    
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

// --- STATE PERSISTENCE ---

function saveSettings() {
    const checkboxes = UI.settingsSection.querySelectorAll('input[type="checkbox"]');
    const settingsState = {};
    
    checkboxes.forEach((cb, index) => {
        const key = cb.id || cb.dataset.groupTarget || cb.dataset.formTarget || cb.dataset.jlptTarget || `cb_${index}`;
        settingsState[key] = cb.checked;
    });

    // Save active radio mode
    const activeRadio = UI.settingsSection.querySelector('input[name="verb-study-mode"]:checked');
    if (activeRadio) {
        settingsState['verb-study-mode'] = activeRadio.value;
    }
    
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

        // Restore radio button state
        if (settingsState['verb-study-mode']) {
            const radio = UI.settingsSection.querySelector(`input[name="verb-study-mode"][value="${settingsState['verb-study-mode']}"]`);
            if (radio) {
                radio.checked = true;
                AppState.currentStudyMode = radio.value;
            }
        }
        updateModeUI();
    }
}

// --- EVENT LISTENERS ---

UI.startBtn.addEventListener('click', initializeSession);

UI.submitBtn.addEventListener('click', () => {
    evaluateAnswer(UI.answerInput.value);
});

UI.groupChoiceBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        evaluateAnswer(e.target.dataset.answer);
    });
});

UI.retakeBtn.addEventListener('click', retakeSession);

UI.revealBtn.addEventListener('click', () => {
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
        const response = await fetch('data.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        AppState.omniDatabase = await response.json();

        // 1. Restore static setting states
        loadSettings();
        // 2. Generate subsets based on static settings & restore subset states
        renderSubsetCheckboxes();
        // 3. Update estimator based on full loaded state
        updateLiveEstimator();
        // 4. Initialize WanaKana text conversion
        wanakana.bind(UI.answerInput, { IMEMode: true });
        // 5. Render the master exclusion lists
        renderMasterLists();
    } catch (error) {
        console.error('Failed to initialize application:', error);
    }
}

initApp();

})();