/* DAW FX RACK - REMASTERED LOGIC */

const EFFECTS_CONFIG = {
    eq: { 
        id: 'eq', name: 'Parametric EQ', icon: 'fa-solid fa-sliders', 
        params: { 
            highGain: { name: 'High', type: 'v-slider', min: -24, max: 24, value: 0, step: 0.1, unit: 'dB' }, 
            midGain:  { name: 'Mid',  type: 'v-slider', min: -24, max: 24, value: 0, step: 0.1, unit: 'dB' },
            lowGain:  { name: 'Low',  type: 'v-slider', min: -24, max: 24, value: 0, step: 0.1, unit: 'dB' }
        } 
    },
    compressor: { 
        id: 'compressor', name: 'Compressor', icon: 'fa-solid fa-compress', 
        params: { 
            threshold: { name: 'Thresh', type: 'v-slider', min: -60, max: 0, value: -24, step: 1, unit: 'dB' }, 
            ratio:     { name: 'Ratio',  type: 'v-slider', min: 1, max: 20, value: 4, step: 0.1, unit: ':1' }, 
            attack:    { name: 'Atk',    type: 'h-slider', min: 0, max: 1, value: 0.003, step: 0.001, unit: 's' }, 
            release:   { name: 'Rel',    type: 'h-slider', min: 0.01, max: 1, value: 0.25, step: 0.001, unit: 's' } 
        } 
    },
    delay: { 
        id: 'delay', name: 'Stereo Delay', icon: 'fa-solid fa-stopwatch', 
        params: { 
            time:     { name: 'Time',   type: 'h-slider', min: 0.01, max: 1.0, value: 0.3, step: 0.01, unit: 's' }, 
            feedback: { name: 'F.Back', type: 'h-slider', min: 0, max: 0.9, value: 0.4, step: 0.01, unit: '%' }, 
            mix:      { name: 'Mix',    type: 'h-slider', min: 0, max: 1, value: 0.4, step: 0.01, unit: '%' } 
        } 
    },
    reverb: { 
        id: 'reverb', name: 'Reverb', icon: 'fa-solid fa-water', 
        params: { 
            decay: { name: 'Size', type: 'h-slider', min: 0.5, max: 5, value: 2, step: 0.1, unit: 's' },
            mix:   { name: 'Mix',   type: 'h-slider', min: 0, max: 1, value: 0.3, step: 0.01, unit: '%' }
        } 
    }
};

class DAWApp {
    constructor() {
        this.dom = {};
        this.audio = { ctx: null, nodes: {}, masterGain: null, analyser: null, sourceNode: null };
        this.state = {
            isPlaying: false, fileLoaded: false, audioBuffer: null,
            startTime: 0, startOffset: 0,
            fxChainOrder: JSON.parse(localStorage.getItem('fxChainOrder')) || ['eq', 'compressor', 'delay', 'reverb'],
            fxParams: {}
        };
        this.reverbBuffer = null;
        this.vizEngine = null;
    }

    init() {
        this.cacheDOM();
        this.initState();
        this.initAudioContext();
        this.initUI();
        this.initEventListeners();
        this.renderFXChain();
        this.loop();
    }

    cacheDOM() {
        const $ = (s) => document.querySelector(s);
        this.dom = {
            fileInput: $('#file-input'), uploadBtn: $('#upload-trigger-btn'),
            fileName: $('#file-name'), playBtn: $('#play-pause-btn'), playIcon: $('#play-pause-btn i'),
            downloadBtn: $('#download-btn'),
            waveformContainer: $('#waveform-container'), 
            mainCanvas: $('#main-visualizer'),
            vizSelector: $('#viz-type-selector'),
            playhead: $('#playhead'),
            currentTime: $('#current-time'), totalDuration: $('#total-duration'),
            fxChainContainer: $('#fx-chain-container'), moduleTemplate: $('#fx-module-template'),
            themeSelector: $('#theme-selector'),
            masterMeterBar: $('#master-meter-bar'), masterReadout: $('#master-db-readout'),
            emptyMsg: $('#empty-chain-msg'), toastContainer: $('#toast-container'),
            resetBtn: $('#global-reset-btn'),
            overlayLayer: $('#overlay-layer'), overlayText: $('#overlay-text')
        };
    }

    initState() {
        const savedTheme = localStorage.getItem('theme') || 'theme-dark';
        document.documentElement.className = savedTheme;
        this.dom.themeSelector.value = savedTheme;

        // Filter out any saved effects that no longer exist in config
        this.state.fxChainOrder = this.state.fxChainOrder.filter(id => EFFECTS_CONFIG[id]);
        
        // Load parameters
        for (const fxId of this.state.fxChainOrder) {
            this.state.fxParams[fxId] = { bypass: false };
            if (EFFECTS_CONFIG[fxId]) {
                for (const paramId in EFFECTS_CONFIG[fxId].params) {
                    this.state.fxParams[fxId][paramId] = EFFECTS_CONFIG[fxId].params[paramId].value;
                }
            }
        }
    }

    initAudioContext() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audio.ctx = new AudioContext();
        this.audio.masterGain = this.audio.ctx.createGain();
        this.audio.analyser = this.audio.ctx.createAnalyser();
        this.audio.analyser.fftSize = 2048; 
        this.audio.analyser.smoothingTimeConstant = 0.88; // Smoother viz
        this.audio.masterGain.connect(this.audio.analyser);
        this.audio.analyser.connect(this.audio.ctx.destination);
        
        // Create Reverb Impulse (Simple Algorithmic Noise)
        const sampleRate = this.audio.ctx.sampleRate;
        const length = sampleRate * 2.0;
        const impulse = this.audio.ctx.createBuffer(2, length, sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
        }
        this.reverbBuffer = impulse;
        
        // Create Live Nodes
        this.createFXNodes(this.audio.ctx, this.audio.nodes);
    }

    createFXNodes(ctx, targetNodeStorage) {
        for (const fxId in EFFECTS_CONFIG) {
            const input = ctx.createGain();
            const output = ctx.createGain();
            const group = { input, output, nodes: {} };
            
            switch(fxId) {
                case 'eq':
                    group.nodes.low = ctx.createBiquadFilter();
                    group.nodes.low.type = 'lowshelf'; group.nodes.low.frequency.value = 320;
                    group.nodes.mid = ctx.createBiquadFilter(); 
                    group.nodes.mid.type = 'peaking'; group.nodes.mid.frequency.value = 1000;
                    group.nodes.high = ctx.createBiquadFilter();
                    group.nodes.high.type = 'highshelf'; group.nodes.high.frequency.value = 3200;
                    input.connect(group.nodes.low).connect(group.nodes.mid).connect(group.nodes.high).connect(output);
                    break;
                case 'compressor':
                    group.nodes.comp = ctx.createDynamicsCompressor();
                    input.connect(group.nodes.comp).connect(output); 
                    break;
                case 'delay':
                    group.nodes.delay = ctx.createDelay(2.0);
                    group.nodes.feedback = ctx.createGain(); 
                    group.nodes.wet = ctx.createGain(); group.nodes.dry = ctx.createGain();
                    input.connect(group.nodes.dry).connect(output);
                    input.connect(group.nodes.delay); 
                    group.nodes.delay.connect(group.nodes.feedback).connect(group.nodes.delay); 
                    group.nodes.delay.connect(group.nodes.wet).connect(output);
                    break;
                case 'reverb':
                    group.nodes.conv = ctx.createConvolver();
                    group.nodes.conv.buffer = this.reverbBuffer; 
                    group.nodes.dry = ctx.createGain(); group.nodes.wet = ctx.createGain();
                    input.connect(group.nodes.dry).connect(output); 
                    input.connect(group.nodes.conv).connect(group.nodes.wet).connect(output);
                    break;
            }
            targetNodeStorage[fxId] = group;
        }
    }

    initUI() {
        this.vizEngine = new VisualizerEngine(this.dom.mainCanvas, this.audio.analyser);
    }

    initEventListeners() {
        // Ripple Effect
        document.addEventListener('click', (e) => {
            if(e.target.closest('.btn') || e.target.closest('.fx-card')) {
                // Optional: Add subtle interaction sound here
            }
        });

        this.dom.uploadBtn.addEventListener('click', () => this.dom.fileInput.click());
        
        this.dom.fileInput.addEventListener('change', async (e) => {
            if(e.target.files.length > 0) {
                await this.triggerOverlay("Importing Audio...", 1000);
                this.handleFileLoad(e);
            }
        });

        this.dom.downloadBtn.addEventListener('click', async () => {
            if (!this.state.fileLoaded) return;
            this.dom.downloadBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Exporting...`;
            await new Promise(r => setTimeout(r, 100)); // UI Refresh
            await this.handleDownload();
            this.dom.downloadBtn.innerHTML = `<i class="fa-solid fa-file-export"></i> Export WAV`;
        });

        this.dom.playBtn.addEventListener('click', async () => {
            if(this.audio.ctx.state === 'suspended') await this.audio.ctx.resume();
            this.state.isPlaying ? this.pause() : this.play();
        });

        this.dom.themeSelector.addEventListener('change', (e) => {
            document.documentElement.className = e.target.value;
            localStorage.setItem('theme', e.target.value);
        });

        this.dom.vizSelector.addEventListener('change', (e) => {
            this.vizEngine.setMode(e.target.value);
        });

        this.dom.resetBtn.addEventListener('click', () => {
            if(confirm("Reset all effects to default?")) {
                localStorage.removeItem('fxChainOrder');
                location.reload();
            }
        });

        // Drag and Drop Logic for Chain
        this.dom.fxChainContainer.addEventListener('dragstart', e => { 
            e.target.classList.add('dragging'); 
            e.dataTransfer.effectAllowed = 'move'; 
            e.dataTransfer.setData('text/plain', null); // Firefox fix
        });
        
        this.dom.fxChainContainer.addEventListener('dragend', e => { 
            e.target.classList.remove('dragging'); 
            this.updateChainOrder(); 
        });
        
        this.dom.fxChainContainer.addEventListener('dragover', e => {
            e.preventDefault();
            const dragging = document.querySelector('.dragging');
            const afterElement = this.getDragAfterElement(this.dom.fxChainContainer, e.clientX);
            if(afterElement == null) { this.dom.fxChainContainer.appendChild(dragging); } 
            else { this.dom.fxChainContainer.insertBefore(dragging, afterElement); }
        });

        // Scrubbing
        this.dom.waveformContainer.addEventListener('click', e => {
            if(!this.state.fileLoaded) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            this.state.startOffset = pct * this.state.audioBuffer.duration;
            if(this.state.isPlaying) { this.pause(); this.play(); } else { this.updatePlayhead(pct); }
        });
    }

    triggerOverlay(text, duration = 0) {
        return new Promise(resolve => {
            this.dom.overlayText.textContent = text;
            this.dom.overlayLayer.classList.add('active');
            
            if (duration > 0) {
                setTimeout(() => {
                    this.dom.overlayLayer.classList.remove('active');
                    resolve();
                }, duration);
            } else {
                resolve();
            }
        });
    }
    
    hideOverlay() {
        this.dom.overlayLayer.classList.remove('active');
    }

    async handleDownload() {
        await this.triggerOverlay("Rendering High Quality WAV...", 0);

        const originalBuffer = this.state.audioBuffer;
        const offlineCtx = new OfflineAudioContext(2, originalBuffer.length, originalBuffer.sampleRate);
        const offlineNodes = {};
        this.createFXNodes(offlineCtx, offlineNodes);
        this.applyParamsToNodes(offlineNodes, offlineCtx.currentTime);

        const source = offlineCtx.createBufferSource();
        source.buffer = originalBuffer;
        this.connectFXChain(source, offlineCtx.destination, offlineNodes);

        source.start(0);
        try {
            const renderedBuffer = await offlineCtx.startRendering();
            const wavBlob = this.bufferToWave(renderedBuffer, renderedBuffer.length);
            const url = URL.createObjectURL(wavBlob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `Studio_Export_${new Date().getTime()}.wav`;
            anchor.click();
            URL.revokeObjectURL(url);
            
            this.hideOverlay();
            this.showToast("Export Complete!");
        } catch (err) {
            console.error(err);
            this.hideOverlay();
            this.showToast("Export Failed!");
        }
    }

    applyParamsToNodes(nodeCollection, time) {
        for(const fxId in this.state.fxParams) {
            const params = this.state.fxParams[fxId];
            const group = nodeCollection[fxId];
            if(!group) continue;

            group.input.gain.setValueAtTime(params.bypass ? 0 : 1, time);

            const nodes = group.nodes;
            if(fxId === 'eq') {
                nodes.low.gain.setValueAtTime(params.lowGain, time);
                nodes.mid.gain.setValueAtTime(params.midGain, time);
                nodes.high.gain.setValueAtTime(params.highGain, time);
            } else if(fxId === 'compressor') {
                if(nodes.comp.threshold) nodes.comp.threshold.setValueAtTime(params.threshold, time);
                if(nodes.comp.ratio) nodes.comp.ratio.setValueAtTime(params.ratio, time);
            } else if(fxId === 'delay') {
                nodes.delay.delayTime.setValueAtTime(params.time, time);
                nodes.feedback.gain.setValueAtTime(params.feedback, time);
                nodes.wet.gain.setValueAtTime(params.mix, time);
                nodes.dry.gain.setValueAtTime(1 - params.mix, time);
            } else if(fxId === 'reverb') {
                nodes.wet.gain.setValueAtTime(params.mix, time);
                nodes.dry.gain.setValueAtTime(1 - params.mix, time);
            }
        }
    }

    bufferToWave(abuffer, len) {
        let numOfChan = abuffer.numberOfChannels,
            length = len * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length),
            view = new DataView(buffer),
            channels = [], i, sample,
            offset = 0, pos = 0;

        // RIFF Chunk
        setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
        // fmt Chunk
        setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
        setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan); setUint16(numOfChan * 2); setUint16(16);
        // data Chunk
        setUint32(0x61746164); setUint32(length - pos - 4);

        for(i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));

        while(pos < length) {
            for(i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0;
                view.setInt16(pos, sample, true); pos += 2;
            }
            offset++;
        }
        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
        return new Blob([buffer], {type: "audio/wav"});
    }

    updateChainOrder() {
        const newOrder = [...this.dom.fxChainContainer.querySelectorAll('.fx-card')].map(el => el.dataset.fxId);
        this.state.fxChainOrder = newOrder;
        localStorage.setItem('fxChainOrder', JSON.stringify(newOrder));
        if(this.audio.sourceNode) {
            this.connectFXChain(this.audio.sourceNode, this.audio.masterGain, this.audio.nodes);
        }
    }

    getDragAfterElement(container, x) {
        const draggableElements = [...container.querySelectorAll('.fx-card:not(.dragging)')];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = x - box.left - box.width / 2;
            if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
            else return closest;
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    async handleFileLoad(e) {
        const file = e.target.files[0];
        if (!file) return;
        if(this.state.isPlaying) this.pause();
        this.dom.fileName.textContent = file.name;
        this.dom.playBtn.disabled = true;
        try {
            const buffer = await file.arrayBuffer();
            this.state.audioBuffer = await this.audio.ctx.decodeAudioData(buffer);
            this.state.fileLoaded = true;
            this.dom.totalDuration.textContent = this.formatTime(this.state.audioBuffer.duration);
            this.dom.playBtn.disabled = false;
            this.dom.downloadBtn.disabled = false;
            this.state.startOffset = 0;
            this.updatePlayhead(0);
            this.showToast("Audio Loaded");
        } catch (err) {
            this.dom.fileName.textContent = "Error loading file";
            console.error(err);
        }
    }

    play() {
        if(!this.state.fileLoaded) return;
        this.audio.sourceNode = this.audio.ctx.createBufferSource();
        this.audio.sourceNode.buffer = this.state.audioBuffer;
        this.connectFXChain(this.audio.sourceNode, this.audio.masterGain, this.audio.nodes);
        this.state.startTime = this.audio.ctx.currentTime;
        this.audio.sourceNode.start(0, this.state.startOffset);
        this.state.isPlaying = true;
        this.dom.playIcon.className = 'fa-solid fa-pause';
        this.loop();
    }

    pause() {
        if(this.audio.sourceNode) try { this.audio.sourceNode.stop(); } catch(e){}
        if(this.state.isPlaying) {
            this.state.startOffset += this.audio.ctx.currentTime - this.state.startTime;
            if(this.state.startOffset >= this.state.audioBuffer.duration) this.state.startOffset = 0;
        }
        this.state.isPlaying = false;
        this.dom.playIcon.className = 'fa-solid fa-play';
    }

    connectFXChain(source, dest, nodeCollection) {
        source.disconnect();
        let head = source;
        this.state.fxChainOrder.forEach(id => {
            const node = nodeCollection[id];
            if(node) { head.connect(node.input); head = node.output; }
        });
        head.connect(dest);
    }

    renderFXChain() {
        this.dom.fxChainContainer.innerHTML = '';
        if(this.state.fxChainOrder.length > 0) this.dom.emptyMsg.style.display = 'none';
        this.state.fxChainOrder.forEach(id => {
            if(EFFECTS_CONFIG[id]) this.dom.fxChainContainer.appendChild(this.createModule(id, EFFECTS_CONFIG[id]));
        });
        this.applyParams();
    }

    createModule(id, config) {
        const clone = this.dom.moduleTemplate.content.cloneNode(true);
        const card = clone.querySelector('.fx-card');
        card.dataset.fxId = id;
        card.querySelector('.module-icon').className = config.icon;
        card.querySelector('.fx-name').textContent = config.name;
        
        const toggle = card.querySelector('.bypass-toggle');
        toggle.checked = !this.state.fxParams[id].bypass;
        toggle.addEventListener('change', (e) => {
            this.state.fxParams[id].bypass = !e.target.checked;
            this.updateNodeParam(id, 'bypass', this.state.fxParams[id].bypass);
            card.classList.toggle('bypassed', this.state.fxParams[id].bypass);
        });
        if(this.state.fxParams[id].bypass) card.classList.add('bypassed');

        const body = card.querySelector('.fx-body');
        for(const paramId in config.params) {
            body.appendChild(this.createSlider(id, paramId, config.params[paramId]));
        }
        return card;
    }

    createSlider(fxId, paramId, conf) {
        const group = document.createElement('div');
        const isVertical = conf.type === 'v-slider';
        group.className = `slider-group ${isVertical ? 'vertical' : 'horizontal'}`;
        
        const input = document.createElement('input');
        input.type = 'range';
        input.min = conf.min; input.max = conf.max; input.step = conf.step;
        input.value = this.state.fxParams[fxId][paramId];
        if(isVertical) input.setAttribute('orient', 'vertical');
        
        const label = document.createElement('span');
        label.className = 'param-label'; label.textContent = conf.name;
        
        const valDisplay = document.createElement('span');
        valDisplay.className = 'param-value';
        const updateVal = (v) => {
            let txt = parseFloat(v).toFixed(conf.step < 0.1 ? 2 : 1);
            if(conf.unit === '%') txt = Math.round(v * 100) + '%';
            else if(conf.unit === 'dB') txt = (v > 0 ? '+' : '') + Math.round(v) + 'dB';
            else if(conf.unit === ':1') txt = Math.round(v) + ':1';
            else txt += conf.unit;
            valDisplay.textContent = txt;
        };

        input.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            this.state.fxParams[fxId][paramId] = v;
            this.updateNodeParam(fxId, paramId, v);
            updateVal(v);
        });
        updateVal(input.value);
        
        if(isVertical) { group.appendChild(valDisplay); group.appendChild(input); group.appendChild(label); } 
        else { group.appendChild(label); group.appendChild(input); group.appendChild(valDisplay); }
        return group;
    }

    updateNodeParam(fxId, paramId, value) {
        const group = this.audio.nodes[fxId];
        if(!group) return;
        const t = this.audio.ctx.currentTime;
        
        if(paramId === 'bypass') { 
            group.input.gain.setTargetAtTime(value ? 0 : 1, t, 0.05); 
            return;
        }

        const nodes = group.nodes;
        // Smooth ramping for parameters
        if(fxId === 'eq') {
            if(paramId === 'lowGain') nodes.low.gain.setTargetAtTime(value, t, 0.1);
            if(paramId === 'midGain') nodes.mid.gain.setTargetAtTime(value, t, 0.1);
            if(paramId === 'highGain') nodes.high.gain.setTargetAtTime(value, t, 0.1);
        } else if(fxId === 'compressor') {
             if(nodes.comp[paramId]) nodes.comp[paramId].setTargetAtTime(value, t, 0.1);
        } else if(fxId === 'delay') {
            if(paramId === 'time') nodes.delay.delayTime.setTargetAtTime(value, t, 0.2);
            if(paramId === 'feedback') nodes.feedback.gain.setTargetAtTime(value, t, 0.1);
            if(paramId === 'mix') { nodes.dry.gain.value = 1-value; nodes.wet.gain.value = value; }
        } else if(fxId === 'reverb') {
            if(paramId === 'mix') { nodes.dry.gain.value = 1-value; nodes.wet.gain.value = value; }
        }
    }

    applyParams() {
        this.applyParamsToNodes(this.audio.nodes, this.audio.ctx.currentTime);
    }

    loop() {
        requestAnimationFrame(this.loop.bind(this));
        if(this.state.isPlaying) {
            const now = this.audio.ctx.currentTime;
            const elapsed = now - this.state.startTime;
            const progress = (this.state.startOffset + elapsed) / this.state.audioBuffer.duration;
            this.updatePlayhead(progress);
            this.dom.currentTime.textContent = this.formatTime(this.state.startOffset + elapsed);
            
            if (progress >= 1) { // Auto stop at end
                this.pause();
                this.updatePlayhead(0);
            }
        }
        
        if (this.vizEngine) this.vizEngine.draw();
        this.updateMeter();
    }

    updateMeter() {
        const data = new Float32Array(this.audio.analyser.fftSize);
        this.audio.analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for(let i=0; i<data.length; i++) sum += data[i] * data[i];
        let rms = Math.sqrt(sum / data.length);
        let db = 20 * Math.log10(rms);
        if(db < -60) db = -60;
        const pct = ((db + 60) / 60) * 100;
        this.dom.masterMeterBar.style.width = `${Math.max(0, pct)}%`;
        this.dom.masterReadout.textContent = `${Math.round(db)} dB`;
    }

    updatePlayhead(pct = 0) {
        this.dom.playhead.style.left = `${pct * 100}%`;
    }

    formatTime(s) {
        if(isNaN(s)) return "0:00";
        const m = Math.floor(s/60);
        const sc = Math.floor(s%60);
        return `${m}:${sc.toString().padStart(2,'0')}`;
    }
    
    showToast(msg) {
        const t = document.createElement('div');
        t.className='toast'; 
        // Styling toast in JS for quick appending
        Object.assign(t.style, {
            position:'fixed', bottom:'30px', right:'30px', 
            background:'var(--surface)', color:'var(--text)', padding:'15px 25px', 
            borderRadius:'8px', boxShadow:'0 10px 30px rgba(0,0,0,0.3)', 
            borderLeft:'4px solid var(--accent)', zIndex: 2000,
            animation: 'fadeInUp 0.3s ease forwards', fontSize: '0.9rem', fontWeight:'600'
        });
        t.innerHTML=`<i class="fa-solid fa-circle-check"></i> &nbsp; ${msg}`;
        this.dom.toastContainer.appendChild(t);
        setTimeout(()=>t.remove(), 3000);
    }
}

class VisualizerEngine {
    constructor(canvas, analyser) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false }); // Optimize alpha
        this.analyser = analyser;
        this.mode = 'bars'; 
        this.dataArray = new Uint8Array(analyser.frequencyBinCount);
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const parent = this.canvas.parentElement;
        this.canvas.width = parent.offsetWidth;
        this.canvas.height = parent.offsetHeight;
    }

    setMode(mode) {
        this.mode = mode;
    }

    getThemeColor() {
        return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    }

    draw() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;
        // Clear with Theme BG color for trail effects or pure clear
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface');
        ctx.fillRect(0, 0, w, h);
        
        const accent = this.getThemeColor();

        if (this.mode === 'wave') this.analyser.getByteTimeDomainData(this.dataArray);
        else this.analyser.getByteFrequencyData(this.dataArray);

        if (this.mode === 'bars') this.drawBars(ctx, w, h, accent);
        else if (this.mode === 'wave') this.drawWave(ctx, w, h, accent);
        else if (this.mode === 'circular') this.drawCircular(ctx, w, h, accent);
        else if (this.mode === 'mirror') this.drawMirror(ctx, w, h, accent);
        else if (this.mode === 'nebula') this.drawNebula(ctx, w, h, accent);
    }

    drawBars(ctx, w, h, color) {
        const bufferLength = this.analyser.frequencyBinCount;
        const barWidth = (w / bufferLength) * 2.5;
        let x = 0;
        ctx.fillStyle = color;
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (this.dataArray[i] / 255) * h;
            ctx.fillRect(x, h - barHeight, barWidth, barHeight);
            x += barWidth + 1;
        }
    }

    drawWave(ctx, w, h, color) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.beginPath();
        const sliceWidth = w * 1.0 / this.analyser.frequencyBinCount;
        let x = 0;
        for (let i = 0; i < this.analyser.frequencyBinCount; i++) {
            const v = this.dataArray[i] / 128.0;
            const y = v * h / 2;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.stroke();
    }

    drawCircular(ctx, w, h, color) {
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) / 3;
        const bars = 64;
        const step = Math.floor(this.analyser.frequencyBinCount / bars);

        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        
        for (let i = 0; i < bars; i++) {
            const value = this.dataArray[i * step];
            const angle = (i / bars) * Math.PI * 2;
            const barH = (value / 255) * (radius * 0.8);
            
            const x1 = cx + Math.cos(angle) * radius;
            const y1 = cy + Math.sin(angle) * radius;
            const x2 = cx + Math.cos(angle) * (radius + barH);
            const y2 = cy + Math.sin(angle) * (radius + barH);
            
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
    }

    drawMirror(ctx, w, h, color) {
        const bufferLength = this.analyser.frequencyBinCount;
        const barWidth = (w / bufferLength) * 4;
        let x = 0;
        ctx.fillStyle = color;
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (this.dataArray[i] / 255) * (h / 2);
            ctx.globalAlpha = 0.8;
            ctx.fillRect(w/2 + x, h/2 - barHeight, barWidth, barHeight * 2);
            ctx.fillRect(w/2 - x, h/2 - barHeight, barWidth, barHeight * 2);
            x += barWidth + 1;
        }
        ctx.globalAlpha = 1;
    }

    drawNebula(ctx, w, h, color) {
        const bars = 30;
        const step = Math.floor(this.analyser.frequencyBinCount / bars);
        ctx.fillStyle = color;
        ctx.shadowBlur = 20;
        ctx.shadowColor = color;
        
        for (let i = 0; i < bars; i++) {
            const value = this.dataArray[i * step];
            if(value < 20) continue;
            
            const x = (Math.sin(i) * w/2) + w/2;
            const y = (Math.cos(i * Date.now() * 0.0001) * h/2) + h/2;
            const size = (value / 255) * 20;
            
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;
    }
}

window.addEventListener('DOMContentLoaded', () => new DAWApp().init());
