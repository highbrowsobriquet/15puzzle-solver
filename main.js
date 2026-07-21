/**
 * 15 PUZZLE SOLVER - SMART UI & AUTO-SETUP
 */

var posit = new Array(16);
var blnkx, blnky;
var mode = 0; // 0=normal, 1=scrambled, 2=edit, 3=solving
var seq = []; 
var stepCount = 0;
var setupCounter = 0; 
var wasSolvedAtLastMove = false; // tracks whether the *previous* position was solved,
                                  // so the timer/step counter can reset on the move that
                                  // follows a completed puzzle instead of resuming it

var stopwatchInterval, startTime, elapsedTime = 0, stopwatchRunning = false;
var puzzleGrid, puzzleContainer, solutionInfo, stopwatchDisplay, stepCounterDisplay, solveBtn;

document.addEventListener('DOMContentLoaded', function() {
    puzzleGrid = document.getElementById('puzzle');
    puzzleContainer = document.querySelector('.puzzle-container');
    solutionInfo = document.getElementById('solutionInfo');
    stopwatchDisplay = document.getElementById('stopwatch');
    stepCounterDisplay = document.getElementById('step-counter');
    solveBtn = document.getElementById('solveBtn');

    document.getElementById('shuffleBtn').onclick = mix;
    document.getElementById('resetBtn').onclick = resetPuzzle;
    solveBtn.onclick = handleSolveClick;
    document.getElementById('setupModeBtn').onclick = toggleSetupMode;

    const inputs = document.querySelectorAll(".switcher__input");
    const switcherEl = document.querySelector(".switcher");
    const THEME_STORAGE_KEY = "15puzzle-theme";

    function applyTheme(value) {
        document.body.classList.remove("light-theme", "dark-theme");
        if (value !== "light") document.body.classList.add(`${value}-theme`);
        // Keep <html>'s class (set early/synchronously in index.html's inline
        // head script, before first paint, to avoid a flash-of-wrong-theme on
        // load) in sync with whatever theme is now active, from whichever
        // source changed it (a click here, or the restored value on load).
        document.documentElement.className = (value !== "light") ? `theme-${value}` : "";
    }

    // Replays the switcher pill's scale-pulse (see .switch-anim-1/2 in
    // style.css). Remove-then-reflow-then-add so it can replay even if
    // triggered twice in a row - same trick used elsewhere in this file for
    // the solved-flash and tile-shake feedback.
    function triggerSwitcherPulse(optionNum) {
        switcherEl.classList.remove('switch-anim-1', 'switch-anim-2');
        void switcherEl.offsetWidth;
        switcherEl.classList.add(`switch-anim-${optionNum}`);
    }

    inputs.forEach((input) => {
        input.addEventListener("change", () => {
            applyTheme(input.value);
            // 'change' only fires from a real user interaction (clicking a
            // theme option) - setting .checked from JS, as the restore step
            // below does on load, does not fire it - so the pill's pulse
            // only ever plays on an actual switch, never on page load/refresh.
            triggerSwitcherPulse(input.getAttribute('c-option'));
            // Persist so the choice survives a refresh (or a whole lot of them).
            try {
                localStorage.setItem(THEME_STORAGE_KEY, input.value);
            } catch (e) {
                // Storage can be unavailable (private browsing, disabled storage,
                // etc.) - theme switching itself should never break because of it.
            }
        });
    });

    // Restore the saved theme's radio state (the actual theme colors are
    // already showing pre-paint, applied by the inline script in index.html's
    // <head> - this just brings the visible UI, e.g. which icon looks
    // "selected", into agreement with that). Setting .checked directly does
    // not fire 'change', so this does not trigger the switch-pulse animation.
    try {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
        if (savedTheme) {
            const matchingInput = document.querySelector(`.switcher__input[value="${savedTheme}"]`);
            if (matchingInput) {
                matchingInput.checked = true;
                applyTheme(savedTheme);
            }
        }
    } catch (e) {
        // Ignore - just keeps the default theme.
    }

    // On mobile, the idle "Click tiles..." hint (#status) and the live
    // solve/setup status (#solutionInfo) share a single spot, with only one
    // shown at a time (see style.css's mobile media query). Rather than a
    // CSS-only :has() selector - which some browsers/WebViews still don't
    // support, silently no-opping the whole hide rule and leaving both
    // texts stacked on top of each other - a MutationObserver here mirrors
    // #solutionInfo's empty/non-empty state onto <body> as a plain class,
    // which every browser can select on. One observer covers every place
    // in this file that sets solutionInfo.textContent, so no individual
    // call site needs to remember to keep it in sync.
    function syncLiveStatusClass() {
        document.body.classList.toggle('has-live-status', solutionInfo.textContent.trim().length > 0);
    }
    new MutationObserver(syncLiveStatusClass).observe(solutionInfo, { childList: true });
    syncLiveStatusClass();

    resetPuzzle();
});

// Note: the actual solving heuristic (Manhattan distance + linear conflicts)
// lives entirely inside the Web Worker created in calculatePath(), since it
// needs to run off the main thread. See calculatePath() for details and the
// reasoning behind the heuristic and move-model choices.

// --- SETUP MODE LOGIC ---
function toggleSetupMode() {
    if (mode !== 2) {
        mode = 2;
        setupCounter = 0;
        posit.fill(-1); 
        puzzleGrid.classList.add('setup-active');
        document.getElementById('setupModeBtn').textContent = "Cancel Setup";
        solutionInfo.textContent = "Place tile: 1";
        updateSolveButtonState(); // Disable solve in setup
    } else {
        resetPuzzle(); 
    }
    display();
}

function handleSetupClick(idx) {
    if (posit[idx] !== -1) return; 
    
    posit[idx] = setupCounter;
    setupCounter++;

    if (setupCounter === 15) {
        let emptyIdx = posit.indexOf(-1);
        if (emptyIdx !== -1) posit[emptyIdx] = 15;
        blnkx = posit.indexOf(15) % 4;
        blnky = Math.floor(posit.indexOf(15) / 4);
        
        mode = 0;
        puzzleGrid.classList.remove('setup-active');
        document.getElementById('setupModeBtn').textContent = "Setup Mode";
        updateSolveButtonState();
        if (solved()) {
            solutionInfo.textContent = "All tiles are placed correctly! Nothing to solve.";
            wasSolvedAtLastMove = true;
            triggerSolvedFlash();
        } else {
            solutionInfo.textContent = "Setup complete! Ready to solve.";
        }
    } else {
        solutionInfo.textContent = `Place tile: ${setupCounter + 1}`;
    }
    display();
}

// --- SOLVER LOGIC ---
function handleSolveClick() {
    if (mode === 2 || solved()) return; 

    // Reset Stopwatch on first Solve click
    if (seq.length === 0) {
        resetStopwatch();
        calculatePath();
    } else {
        executeNextMove();
    }
}

function calculatePath() {
    mode = 3;
    solutionInfo.textContent = "Analyzing slides...";
    solveBtn.disabled = true;

    const workerCode = `
        // ---- Heuristic pieces (Manhattan distance + linear conflicts) ----
        // Both are computed over SINGLE-CELL blank moves (blank swaps with one
        // orthogonal neighbor), which is what makes Manhattan distance an
        // admissible heuristic here. The old version searched over "slide a
        // whole run of tiles" moves directly, where a single move can reduce
        // the Manhattan sum by more than 1 - making the heuristic inadmissible
        // and causing IDA* to explore combined with a branching factor of up
        // to 6, which is what produced the freezes. We search single-cell
        // moves (branching factor <= 4, correct heuristic) and merge the
        // result into line-slides afterwards for the UI.
        function manhattanOf(val, idx) {
            if (val === 15) return 0;
            return Math.abs((val % 4) - (idx % 4)) + Math.abs(Math.floor(val / 4) - Math.floor(idx / 4));
        }
        function rowConflicts(board, row) {
            let c = 0;
            for (let c1 = 0; c1 < 4; c1++) {
                let i1 = row * 4 + c1, v1 = board[i1];
                if (v1 === 15 || Math.floor(v1 / 4) !== row) continue;
                for (let c2 = c1 + 1; c2 < 4; c2++) {
                    let i2 = row * 4 + c2, v2 = board[i2];
                    if (v2 === 15 || Math.floor(v2 / 4) !== row) continue;
                    if ((v1 % 4) > (v2 % 4)) c += 2;
                }
            }
            return c;
        }
        function colConflicts(board, col) {
            let c = 0;
            for (let r1 = 0; r1 < 4; r1++) {
                let i1 = r1 * 4 + col, v1 = board[i1];
                if (v1 === 15 || (v1 % 4) !== col) continue;
                for (let r2 = r1 + 1; r2 < 4; r2++) {
                    let i2 = r2 * 4 + col, v2 = board[i2];
                    if (v2 === 15 || (v2 % 4) !== col) continue;
                    if (Math.floor(v1 / 4) > Math.floor(v2 / 4)) c += 2;
                }
            }
            return c;
        }
        function fullManhattan(board) {
            let h = 0;
            for (let i = 0; i < 16; i++) h += manhattanOf(board[i], i);
            return h;
        }
        function fullConflicts(board) {
            let c = 0;
            for (let r = 0; r < 4; r++) c += rowConflicts(board, r);
            for (let c2 = 0; c2 < 4; c2++) c += colConflicts(board, c2);
            return c;
        }
        function heuristic(board) { return fullManhattan(board) + fullConflicts(board); }
        function neighbors1(bPos) {
            let n = [];
            let bx = bPos % 4, by = Math.floor(bPos / 4);
            if (bx > 0) n.push(bPos - 1);
            if (bx < 3) n.push(bPos + 1);
            if (by > 0) n.push(bPos - 4);
            if (by < 3) n.push(bPos + 4);
            return n;
        }
        function mergeToLineSlides(unitPath, startBlankPos) {
            let merged = [];
            let i = 0;
            let curBlank = startBlankPos;
            while (i < unitPath.length) {
                let dir = unitPath[i] - curBlank;
                let j = i, b = curBlank;
                while (j < unitPath.length && (unitPath[j] - b) === dir) {
                    b = unitPath[j];
                    j++;
                }
                merged.push(b);
                curBlank = b;
                i = j;
            }
            return merged;
        }

        // ---- Optimal search: IDA* with incremental heuristic updates ----
        // Only the row(s)/column(s) touched by the moving tile can change
        // conflict counts, and only the moved tile's own Manhattan distance
        // changes, so we update the heuristic in O(1)-ish instead of
        // rescanning all 16 cells at every one of the millions of nodes.
        function solveIDA(initBoard, timeLimitMs) {
            let board = initBoard.slice();
            let path = [];
            let nodes = 0;
            const start = Date.now();
            let timedOut = false;

            function search(g, bound, blankPos, lastPos, h) {
                nodes++;
                if (nodes % 300000 === 0 && (Date.now() - start) > timeLimitMs) {
                    timedOut = true;
                    return "FOUND";
                }
                if (g + h > bound) return g + h;
                if (h === 0) return "FOUND";
                let min = Infinity;
                let bx = blankPos % 4, by = Math.floor(blankPos / 4);
                for (let nextPos of neighbors1(blankPos)) {
                    if (nextPos === lastPos) continue;
                    let moved = board[nextPos];
                    let nx = nextPos % 4, ny = Math.floor(nextPos / 4);

                    let before = (ny === by) ? rowConflicts(board, by) : rowConflicts(board, by) + rowConflicts(board, ny);
                    before += (nx === bx) ? colConflicts(board, bx) : colConflicts(board, bx) + colConflicts(board, nx);
                    let mDelta = manhattanOf(moved, blankPos) - manhattanOf(moved, nextPos);

                    board[blankPos] = moved;
                    board[nextPos] = 15;

                    let after = (ny === by) ? rowConflicts(board, by) : rowConflicts(board, by) + rowConflicts(board, ny);
                    after += (nx === bx) ? colConflicts(board, bx) : colConflicts(board, bx) + colConflicts(board, nx);

                    let newH = h + mDelta + (after - before);
                    let t = search(g + 1, bound, nextPos, blankPos, newH);
                    if (t === "FOUND") { path.push(nextPos); return "FOUND"; }

                    board[nextPos] = moved;
                    board[blankPos] = 15;
                    if (t < min) min = t;
                }
                return min;
            }

            let h0 = heuristic(board);
            let bound = h0;
            // 80 unit-moves is already a generous cap (worst-case optimal 15-puzzle
            // solutions top out well under this), so malformed/unsolvable boards
            // can't spin this loop forever even without the time limit.
            while (bound <= 80 && !timedOut) {
                let t = search(0, bound, board.indexOf(15), -1, h0);
                if (t === "FOUND") break;
                bound = t + 1;
            }
            return { path: timedOut ? null : path.reverse(), timedOut, nodes };
        }

        // ---- Fallback: weighted A* ----
        // Only used on the rare board where optimal IDA* doesn't finish in its
        // time budget. Trades solution length for a search that is guaranteed
        // to terminate quickly (it explores far fewer states than IDA* would
        // need to *prove* optimality, at the cost of not being optimal).
        function solveWeightedAStar(initBoard, timeLimitMs) {
            const start = Date.now();
            let nodes = 0;
            const W = 1.5;

            function MinHeap() { this.a = []; }
            MinHeap.prototype.push = function(item) {
                this.a.push(item);
                let i = this.a.length - 1;
                while (i > 0) {
                    let p = (i - 1) >> 1;
                    if (this.a[p][0] <= this.a[i][0]) break;
                    [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
                    i = p;
                }
            };
            MinHeap.prototype.pop = function() {
                let top = this.a[0];
                let last = this.a.pop();
                if (this.a.length) {
                    this.a[0] = last;
                    let i = 0;
                    while (true) {
                        let l = 2 * i + 1, r = 2 * i + 2, s = i;
                        if (l < this.a.length && this.a[l][0] < this.a[s][0]) s = l;
                        if (r < this.a.length && this.a[r][0] < this.a[s][0]) s = r;
                        if (s === i) break;
                        [this.a[s], this.a[i]] = [this.a[i], this.a[s]];
                        i = s;
                    }
                }
                return top;
            };

            // Two 32-bit halves (8 tiles x 4 bits each) joined into one string.
            // Cheap to build and collision-free, unlike board.join(',') (slower,
            // ~14x in testing) or packing all 16 tiles into a single JS number
            // (64 bits doesn't fit in a safe integer - silently corrupts on
            // collision past 2^53, which is exactly why this needs two halves).
            function packBoardKey(board) {
                let lo = 0, hi = 0;
                for (let i = 0; i < 8; i++) lo = lo * 16 + board[i];
                for (let i = 8; i < 16; i++) hi = hi * 16 + board[i];
                return lo + ',' + hi;
            }

            let startBlank = initBoard.indexOf(15);
            let h0 = heuristic(initBoard);
            let heap = new MinHeap();
            // Parent-pointer chain instead of a full path array per node: each
            // pool entry stores just the move it made and an index back to its
            // parent. The path is reconstructed once at the end by walking
            // these pointers, instead of spreading a growing array
            // ([...path, nextPos]) at every single expansion - that spread was
            // O(depth) per node, O(depth^2) total, and was the main cost here.
            let nodePool = [{ move: -1, parent: -1 }];
            heap.push([W * h0, 0, initBoard.slice(), startBlank, -1, 0]);
            let visited = new Set();
            visited.add(packBoardKey(initBoard));

            while (heap.a.length > 0) {
                nodes++;
                if (nodes % 50000 === 0 && (Date.now() - start) > timeLimitMs) {
                    return { path: null, timedOut: true, nodes };
                }
                let [f, g, board, blankPos, lastPos, nodeIdx] = heap.pop();
                let h = heuristic(board);
                if (h === 0) {
                    let path = [];
                    let cur = nodeIdx;
                    while (nodePool[cur].parent !== -1) {
                        path.push(nodePool[cur].move);
                        cur = nodePool[cur].parent;
                    }
                    path.reverse();
                    return { path, timedOut: false, nodes };
                }
                for (let nextPos of neighbors1(blankPos)) {
                    if (nextPos === lastPos) continue;
                    let nb = board.slice();
                    nb[blankPos] = nb[nextPos];
                    nb[nextPos] = 15;
                    let key = packBoardKey(nb);
                    if (visited.has(key)) continue;
                    visited.add(key);
                    let hh = heuristic(nb);
                    let newNodeIdx = nodePool.length;
                    nodePool.push({ move: nextPos, parent: nodeIdx });
                    heap.push([g + 1 + W * hh, g + 1, nb, nextPos, blankPos, newNodeIdx]);
                }
            }
            return { path: null, timedOut: false, nodes }; // exhausted state space: unsolvable
        }

        onmessage = function(e) {
            let initBoard = e.data.board;
            let startBlank = initBoard.indexOf(15);

            const IDA_TIME_BUDGET_MS = 2000;
            let result = solveIDA(initBoard, IDA_TIME_BUDGET_MS);
            let optimal = true;

            if (!result.path) {
                // IDA* couldn't prove optimality within its budget (rare, only on
                // the hardest-to-search boards) - fall back to a search that is
                // guaranteed to finish quickly, even if the path isn't shortest.
                const FALLBACK_TIME_BUDGET_MS = 5000;
                result = solveWeightedAStar(initBoard, FALLBACK_TIME_BUDGET_MS);
                optimal = false;
            }

            if (!result.path) {
                postMessage({ ok: false });
                return;
            }

            let merged = mergeToLineSlides(result.path, startBlank);
            postMessage({ ok: true, seq: merged, optimal: optimal });
        };
    `;

    const blob = new Blob([workerCode], {type: 'application/javascript'});
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    // Safety net: IDA* budget + fallback budget are bounded above (~7s), but if
    // anything unexpected happens (e.g. a slow device), don't leave the UI
    // stuck forever waiting on a worker that never replies.
    const watchdog = setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        mode = 0;
        solutionInfo.textContent = "Solver took too long and was stopped. Try again or Reset.";
        solveBtn.textContent = "Solve";
        updateSolveButtonState();
    }, 15000);

    worker.onmessage = function(e) {
        clearTimeout(watchdog);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);

        if (!e.data || !e.data.ok) {
            mode = 0;
            seq = [];
            solutionInfo.textContent = "Couldn't find a solution for this position.";
            updateSolveButtonState();
            display();
            return;
        }

        seq = e.data.seq;
        mode = 0;
        solutionInfo.textContent = e.data.optimal
            ? `Optimal path: ${seq.length} slides.`
            : `Found a path: ${seq.length} slides.`;
        solveBtn.textContent = "Solve (next\u00A0move)";
        updateSolveButtonState();
        display();
    };
    worker.onerror = function() {
        clearTimeout(watchdog);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        mode = 0;
        seq = [];
        solutionInfo.textContent = "Solver hit an error. Please try again.";
        updateSolveButtonState();
        display();
    };
    worker.postMessage({ board: [...posit] });
}

function executeNextMove() {
    if (seq.length > 0) {
        startNewAttemptIfNeeded();
        let targetIdx = seq.shift();
        slideTiles(targetIdx);
        incrementStepCounter();
        display();
        
        if (solved()) {
            mode = 0; 
            seq = []; 
            solutionInfo.textContent = "Solved!";
            solveBtn.textContent = "Solve";
            updateSolveButtonState();
            wasSolvedAtLastMove = true;
            triggerSolvedFlash();
        } else {
            solutionInfo.textContent = `Slides remaining: ${seq.length}`;
        }
    }
}

// --- CORE ENGINE ---
function slideTiles(targetIdx) {
    let tx = targetIdx % 4, ty = Math.floor(targetIdx / 4);
    if (ty === blnky) {
        let step = (tx > blnkx) ? 1 : -1;
        for (let x = blnkx; x !== tx; x += step) posit[blnky * 4 + x] = posit[blnky * 4 + x + step];
    } else if (tx === blnkx) {
        let step = (ty > blnky) ? 4 : -4;
        for (let p = (blnky * 4 + blnkx); p !== targetIdx; p += step) posit[p] = posit[p + step];
    }
    posit[targetIdx] = 15;
    blnkx = tx; blnky = ty;
    updateSolveButtonState();
}

function display() {
    puzzleGrid.innerHTML = '';
    let nextStepIdx = (seq.length > 0) ? seq[0] : -1;

    for (let i = 0; i < 16; i++) {
        let div = document.createElement('div');
        div.className = 'tile';
        
        if (posit[i] === -1) {
            div.classList.add('setup-empty');
            if (mode === 2) div.onclick = function() { handleSetupClick(i); };
        } else if (posit[i] === 15) {
            div.classList.add('empty');
        } else {
            div.textContent = posit[i] + 1;
            if (posit[i] === i) {
                div.classList.add('correct');
            }
            if (i === nextStepIdx) {
                div.style.backgroundColor = "var(--c-mv)";
                div.style.boxShadow = "inset 0 0 0 4px #4CAF50";
            }
            if (mode !== 2) {
                div.onclick = function() {
                    if (i === nextStepIdx) {
                        // This is the tile the computed solution wants to move next -
                        // clicking it IS "advance the auto-solve", so it should do
                        // exactly what the Solve button does, not be treated as a
                        // manual move that throws the rest of the plan away.
                        executeNextMove();
                    } else if (isMovable(i)) {
                        seq = [];
                        solveBtn.textContent = "Solve";
                        solutionInfo.textContent = "";
                        startNewAttemptIfNeeded();
                        slideTiles(i);
                        if (!stopwatchRunning) startStopwatch();
                        incrementStepCounter();
                        display();
                        if (solved()) {
                            mode = 0;
                            stopStopwatch();
                            wasSolvedAtLastMove = true;
                            triggerSolvedFlash();
                        }
                    } else {
                        triggerShake(this);
                    }
                };
            }
        }
        puzzleGrid.appendChild(div);
    }
}

function updateSolveButtonState() {
    if (mode === 2 || solved()) {
        solveBtn.disabled = true;
    } else {
        solveBtn.disabled = false;
    }
}

function isMovable(idx) {
    let tx = idx % 4, ty = Math.floor(idx / 4);
    return (tx === blnkx || ty === blnky) && idx !== (blnky * 4 + blnkx);
}

function mix() {
    let pcs = Array.from({length: 15}, (_, i) => i);
    for (let i = 14; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pcs[i], pcs[j]] = [pcs[j], pcs[i]];
    }
    let inv = 0;
    for (let i = 0; i < 15; i++) {
        for (let j = i + 1; j < 15; j++) { if (pcs[i] > pcs[j]) inv++; }
    }
    if (inv % 2 !== 0) [pcs[0], pcs[1]] = [pcs[1], pcs[0]];
    for (let i = 0; i < 15; i++) posit[i] = pcs[i];
    posit[15] = 15;
    blnkx = 3; blnky = 3;
    mode = 1; seq = [];
    wasSolvedAtLastMove = false;
    solveBtn.textContent = "Solve";
    resetStopwatch();
    resetStepCounter();
    solutionInfo.textContent = "";
    updateSolveButtonState();
    display();
}

function solved() { return posit.every((val, i) => val === i); }

function resetPuzzle() {
    for (let i = 0; i < 16; i++) posit[i] = i;
    blnkx = 3; blnky = 3;
    mode = 0; seq = [];
    wasSolvedAtLastMove = false;
    solveBtn.textContent = "Solve";
    puzzleGrid.classList.remove('setup-active');
    document.getElementById('setupModeBtn').textContent = "Setup Mode";
    resetStopwatch();
    resetStepCounter();
    solutionInfo.textContent = "";
    updateSolveButtonState();
    display();
}

// --- UTILS ---
function incrementStepCounter() { stepCount++; stepCounterDisplay.textContent = 'Steps: ' + stepCount; }
function resetStepCounter() { stepCount = 0; stepCounterDisplay.textContent = 'Steps: 0'; }
function startStopwatch() { if (!stopwatchRunning) { startTime = Date.now() - elapsedTime; stopwatchInterval = setInterval(updateStopwatch, 10); stopwatchRunning = true; } }
function stopStopwatch() { clearInterval(stopwatchInterval); stopwatchRunning = false; }
function resetStopwatch() { stopStopwatch(); elapsedTime = 0; stopwatchDisplay.textContent = '00:00:00'; }
function updateStopwatch() {
    elapsedTime = Date.now() - startTime;
    let m = String(Math.floor(elapsedTime / 60000)).padStart(2, '0');
    let s = String(Math.floor((elapsedTime % 60000) / 1000)).padStart(2, '0');
    let ms = String(Math.floor((elapsedTime % 1000) / 10)).padStart(2, '0');
    stopwatchDisplay.textContent = `${m}:${s}:${ms}`;
}

// Plays the green "solved" flash around the grid perimeter. Removing then
// re-adding the class (with a forced reflow in between via offsetWidth)
// lets the animation replay even if it's triggered twice in a row.
function triggerSolvedFlash() {
    puzzleContainer.classList.remove('solved-flash');
    void puzzleContainer.offsetWidth;
    puzzleContainer.classList.add('solved-flash');
}

// Quick shake feedback when clicking a tile that isn't adjacent to the
// blank (so clicking it can't actually move it). Same remove/reflow/re-add
// trick as triggerSolvedFlash so it can replay on repeated wrong clicks.
function triggerShake(tileEl) {
    tileEl.classList.remove('shake');
    void tileEl.offsetWidth;
    tileEl.classList.add('shake');
}

// Call this right before applying a move (manual click or auto-solve step).
// If the position was solved *before* this move, treat the move as the start
// of a fresh attempt: reset the timer and step counter instead of letting
// them resume from the finished run's frozen values.
function startNewAttemptIfNeeded() {
    if (wasSolvedAtLastMove) {
        resetStopwatch();
        resetStepCounter();
        wasSolvedAtLastMove = false;
    }
}