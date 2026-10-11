export {
    CARET_COLOR,
    CARET_RENDER_ORDER,
    cpToU16,
    cpLen,
    clampCursor,
    insertText,
    deleteBackward,
    deleteForward,
    splitLine,
    moveCursor,
    createCaretMesh,
    positionCaretMesh,
} from './GridEditor.js';

export {
    clampWindow,
    sliceWindowText,
    computeMaxScroll,
    clampScroll,
    computeFrameClip,
} from './GridWindow.js';

export {
    computeBackgroundLayout,
    createBackgroundMesh,
    fitBackground,
} from './GridBackground.js';

export {
    applyRangeHighlight,
    clearLineHighlight,
    clearAllHighlights,
} from './GridHighlight.js';
