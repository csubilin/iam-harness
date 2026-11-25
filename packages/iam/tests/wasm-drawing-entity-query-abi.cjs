const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
// Run after building IamDrawingView; no canvas or GPU is needed for no_view.
const wasmOutputDirectory = path.resolve(process.argv[2] || 'build/bin/wasm/views');
const preloadedDrawingData = fs.readFileSync(path.join(wasmOutputDirectory, 'IamDrawingView.data'));
const drawingViewScriptPath = path.join(wasmOutputDirectory, 'IamDrawingView.js');
const wasmRuntimeContext = { require, process, console, TextDecoder, TextEncoder,
  setTimeout, clearTimeout, setInterval, clearInterval,
  __dirname: wasmOutputDirectory, __filename: drawingViewScriptPath,
  Module: {
    noInitialRun: true,
    wasmBinary: fs.readFileSync(path.join(wasmOutputDirectory, 'IamDrawingView.wasm')),
    getPreloadedPackage: () => preloadedDrawingData.buffer.slice(
      preloadedDrawingData.byteOffset, preloadedDrawingData.byteOffset + preloadedDrawingData.byteLength,
    ),
    onAbort: reason => { console.error(reason); process.exitCode = 1; },
    onRuntimeInitialized() {
      try {
        const drawingViewModule = wasmRuntimeContext.Module;
        for (const exportSuffix of ['Query', 'Poll', 'Release'])
          assert.equal(typeof drawingViewModule['_iamViewAgentDrawing' + exportSuffix], 'function');
        const requestId = drawingViewModule._iamViewAgentDrawingQuery(2, 0, 0, 0, 1000, 1, 0, 4194304, 0, 0);
        assert.ok(requestId);
        const requestStatePointer = drawingViewModule._malloc(8);
        const requiredResponseBytesPointer = requestStatePointer + 4;
        assert.equal(drawingViewModule._iamViewAgentDrawingPoll(
          requestId, requestStatePointer, 0, 0, requiredResponseBytesPointer,
        ), 0);
        const responseByteCount = new DataView(drawingViewModule.HEAPU8.buffer).getUint32(requiredResponseBytesPointer, true);
        const responseJsonPointer = drawingViewModule._malloc(responseByteCount);
        assert.equal(drawingViewModule._iamViewAgentDrawingPoll(
          requestId, requestStatePointer, responseJsonPointer, responseByteCount, requiredResponseBytesPointer,
        ), 0);
        const responseJsonBytes = drawingViewModule.HEAPU8.subarray(
          responseJsonPointer, responseJsonPointer + responseByteCount - 1,
        );
        const response = JSON.parse(new TextDecoder().decode(responseJsonBytes));
        assert.equal(response.error.code, 'no_view');
        assert.equal(drawingViewModule._iamViewAgentDrawingRelease(requestId), 0);
        drawingViewModule._free(responseJsonPointer);
        drawingViewModule._free(requestStatePointer);
        console.log('Wasm runtime ABI query/poll/release: passed (no_view)');
      } catch (error) { console.error(error); process.exitCode = 1; }
    },
  },
};
vm.createContext(wasmRuntimeContext);
vm.runInContext(fs.readFileSync(drawingViewScriptPath, 'utf8'), wasmRuntimeContext, { filename: drawingViewScriptPath });
