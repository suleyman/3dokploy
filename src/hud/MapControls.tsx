import { useStore } from '../store';
import { fullscreenSupported, toggleFullscreen, useFullscreen } from './fullscreen';
import { ExpandIcon, FlameIcon, MinusIcon, MuteIcon, PlusIcon, ResetIcon, ShrinkIcon, SoundIcon } from './icons';

export function MapControls() {
  const heatmap = useStore((s) => s.heatmap);
  const metrics = useStore((s) => s.capabilities.metrics);
  const muted = useStore((s) => s.muted);
  const fullscreen = useFullscreen();
  const cmd = useStore((s) => s.cameraCommand);

  return (
    <nav className="rail" aria-label="Map controls">
      <div className="rail-group panel">
        <button type="button" className="icon-btn" onClick={() => cmd('zoomIn')} aria-label="Zoom in" title="Zoom in">
          <PlusIcon />
        </button>
        <button type="button" className="icon-btn" onClick={() => cmd('zoomOut')} aria-label="Zoom out" title="Zoom out">
          <MinusIcon />
        </button>
        <button type="button" className="icon-btn" onClick={() => cmd('reset')} aria-label="Reset view" title="Reset view">
          <ResetIcon />
        </button>
        {fullscreenSupported() && (
          <button
            type="button"
            className={`icon-btn ${fullscreen ? 'is-on' : ''}`}
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Exit fullscreen (Shift+F)' : 'Fullscreen (Shift+F)'}
          >
            {fullscreen ? <ShrinkIcon /> : <ExpandIcon />}
          </button>
        )}
      </div>
      {metrics && (
        <div className="rail-group panel">
          <button
            type="button"
            className={`icon-btn ${heatmap ? 'is-on' : ''}`}
            onClick={() => useStore.getState().toggleHeatmap()}
            aria-pressed={heatmap}
            aria-label="CPU heatmap"
            title="CPU heatmap"
          >
            <FlameIcon />
          </button>
        </div>
      )}
      <div className="rail-group panel">
        <button
          type="button"
          className={`icon-btn ${muted ? '' : 'is-on'}`}
          onClick={() => useStore.getState().toggleMute()}
          aria-pressed={!muted}
          aria-label={muted ? 'Turn sound on' : 'Mute sound'}
          title={muted ? 'Sound off (M)' : 'Sound on (M)'}
        >
          {muted ? <MuteIcon /> : <SoundIcon />}
        </button>
      </div>
      {metrics && heatmap && (
        <div className="heat-legend panel" aria-hidden>
          <span>100%</span>
          <i />
          <span>0%</span>
        </div>
      )}
    </nav>
  );
}
