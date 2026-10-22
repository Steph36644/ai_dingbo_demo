class PcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    const frames = channels[0].length;
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels.length; c += 1) sum += channels[c][i] || 0;
      mono[i] = sum / channels.length;
    }
    this.port.postMessage(mono);
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
