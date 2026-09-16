import React, { useState } from 'react';
import { audioEngine } from '../core/audioEngine';
import type { SessionNode } from '../types/sessionTree';

export interface ArtifactPaneProps {
  node: SessionNode;
  onUpdateContent?: (content: string) => void;
  onClose?: () => void;
}

export const ArtifactPane: React.FC<ArtifactPaneProps> = ({
  node,
  onUpdateContent,
  onClose,
}) => {
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);

  const title = node.artifactTitle || node.title || 'Untitled Artifact';
  const content = node.artifactContent ?? '';
  const type = (node.artifactType || 'markdown').toLowerCase();
  const version = node.artifactVersion || 1;
  const artifactId = node.artifactId || node.id;

  const handleCopy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).catch?.(() => undefined);
    }
    audioEngine.playSound('click', 3);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleOpenInBrowser = () => {
    const port = window.location.port === '1420' ? '1421' : window.location.port || '1421';
    const url = `http://${window.location.hostname || '127.0.0.1'}:${port}/artifact/${artifactId}`;
    window.open(url, '_blank');
    audioEngine.playSound('click', 3);
  };

  return (
    <div className="flex flex-col h-full font-mono p-2 recess select-none overflow-hidden" data-testid="artifact-pane">
      {/* Plate Header */}
      <div
        className="flex justify-between items-center px-2 py-1 mb-2 plate font-bold"
        style={{ color: 'var(--ink-plate)' }}
      >
        <div className="flex items-center gap-2 truncate min-w-0">
          <span className="text-[13px]">❖</span>
          <span className="truncate text-[12px]">ARTIFACT: {title}</span>
          <span
            className="px-1 py-0.2 text-[10px] bev-dn"
            style={{ background: 'var(--ground)', color: 'var(--st-live)' }}
          >
            [{type.toUpperCase()}]
          </span>
          <span
            className="px-1 py-0.2 text-[10px] bev-dn"
            style={{ background: 'var(--ground)', color: 'var(--ink-dim)' }}
          >
            v{version}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setViewMode(viewMode === 'preview' ? 'source' : 'preview')}
            className="px-1.5 py-0.5 text-[10px] recess hover:bg-[#1f1d19]"
            style={{ color: 'var(--ink)' }}
            title="Toggle between rendered preview and raw source"
          >
            {viewMode === 'preview' ? 'SOURCE' : 'RENDER'}
          </button>
          <button
            onClick={handleOpenInBrowser}
            className="px-1.5 py-0.5 text-[10px] recess hover:bg-[#1f1d19]"
            style={{ color: 'var(--st-live)' }}
            title="Open standalone artifact in external browser with live reload"
          >
            BROWSER ↗
          </button>
          <button
            onClick={handleCopy}
            className="px-1.5 py-0.5 text-[10px] recess hover:bg-[#1f1d19]"
            style={{ color: 'var(--ink)' }}
          >
            {copied ? 'COPIED!' : 'COPY'}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-[12px] px-1 hover:text-[var(--st-fail)]"
              style={{ color: 'var(--ink-plate)' }}
              title="Close artifact pane"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Recess Content Area */}
      <div
        className="flex-1 flex flex-col min-h-0 min-w-0 bev-dn p-3 overflow-y-auto"
        style={{ background: 'var(--ground-2)' }}
      >
        {viewMode === 'source' ? (
          <textarea
            value={content}
            onChange={(e) => onUpdateContent?.(e.target.value)}
            placeholder="Raw artifact content..."
            className="w-full h-full bg-transparent text-[12px] leading-relaxed text-[#d8cbb0] focus:outline-none resize-none font-mono"
            spellCheck={false}
          />
        ) : type === 'diff' ? (
          <DiffViewer content={content} />
        ) : type === 'html' || type === 'dashboard' ? (
          <HtmlViewer content={content} onOpenExternal={handleOpenInBrowser} />
        ) : type === 'image' ? (
          <ImageViewer content={content} title={title} />
        ) : (
          <MarkdownViewer content={content} />
        )}
      </div>
    </div>
  );
};

interface DiffViewerProps {
  content: string;
}

const DiffViewer: React.FC<DiffViewerProps> = ({ content }) => {
  if (!content.trim()) {
    return <div className="text-[12px] italic text-[#8f8672]">[Empty diff]</div>;
  }

  const lines = content.split('\n');

  return (
    <div className="flex flex-col gap-0 text-[12px] font-mono leading-tight select-text">
      {lines.map((line, idx) => {
        if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
          return (
            <div
              key={idx}
              className="font-bold py-1 px-2 my-0.5 bev-dn truncate"
              style={{ background: '#26221c', color: 'var(--ink)' }}
            >
              {line}
            </div>
          );
        }
        if (line.startsWith('@@')) {
          return (
            <div
              key={idx}
              className="py-0.5 px-2 my-0.5"
              style={{ background: '#1c1914', color: 'var(--ink-dim)' }}
            >
              {line}
            </div>
          );
        }
        if (line.startsWith('+')) {
          return (
            <div
              key={idx}
              className="px-2 py-0.5"
              style={{ background: 'rgba(92, 156, 58, 0.15)', color: '#8cd665' }}
            >
              {line}
            </div>
          );
        }
        if (line.startsWith('-')) {
          return (
            <div
              key={idx}
              className="px-2 py-0.5"
              style={{ background: 'rgba(239, 65, 54, 0.15)', color: '#ff7b72' }}
            >
              {line}
            </div>
          );
        }
        return (
          <div key={idx} className="px-2 py-0.5 text-[#d8cbb0]">
            {line || '\u00A0'}
          </div>
        );
      })}
    </div>
  );
};

interface HtmlViewerProps {
  content: string;
  onOpenExternal: () => void;
}

const HtmlViewer: React.FC<HtmlViewerProps> = ({ content, onOpenExternal }) => {
  return (
    <div className="flex flex-col h-full gap-3 font-mono">
      <div
        className="p-3 bev-dn flex justify-between items-center"
        style={{ background: 'var(--ground)', borderLeft: '3px solid var(--st-live)' }}
      >
        <div className="flex flex-col gap-1">
          <div className="text-[12px] font-bold" style={{ color: 'var(--ink)' }}>
            Interactive HTML / Web Application Artifact
          </div>
          <div className="text-[11px]" style={{ color: 'var(--ink-dim)' }}>
            Full scripts and interactive widgets run in dedicated browser windows with automatic live reloading.
          </div>
        </div>
        <button
          onClick={onOpenExternal}
          className="px-3 py-1.5 text-[11px] font-bold plate bev-up"
          style={{ color: 'var(--ink-plate)' }}
        >
          LAUNCH INTERACTIVE VIEW ↗
        </button>
      </div>

      <div className="flex-1 flex flex-col min-h-0 bev-dn p-2" style={{ background: '#0e0d0b' }}>
        <div className="text-[10px] font-bold mb-1" style={{ color: 'var(--ink-dim)' }}>
          SOURCE PREVIEW:
        </div>
        <pre className="flex-1 overflow-auto text-[11px] leading-relaxed text-[#c8bb9c] font-mono select-text">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
};

interface ImageViewerProps {
  content: string;
  title: string;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ content, title }) => {
  const [zoomMode, setZoomMode] = useState<'fit' | 'natural'>('fit');
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const src = content.trim();
  if (!src) {
    return <div className="text-[12px] italic text-[#8f8672]">[Empty image artifact]</div>;
  }

  return (
    <div className="flex flex-col h-full gap-2 font-mono" data-testid="image-viewer">
      <div
        className="px-2 py-1 flex justify-between items-center bev-dn text-[11px]"
        style={{ background: 'var(--ground)' }}
      >
        <div className="flex items-center gap-2" style={{ color: 'var(--ink-dim)' }}>
          <span>MODE:</span>
          <button
            onClick={() => setZoomMode(zoomMode === 'fit' ? 'natural' : 'fit')}
            className="px-1.5 py-0.5 text-[10px] plate bev-up font-bold cursor-pointer"
            style={{ color: 'var(--ink-plate)' }}
            data-testid="image-zoom-toggle"
          >
            {zoomMode === 'fit' ? '1:1 ORIGINAL' : 'FIT TO PANE'}
          </button>
        </div>
        {naturalSize && (
          <div className="text-[10px]" style={{ color: 'var(--ink-dim)' }} data-testid="image-dimensions">
            {naturalSize.width} × {naturalSize.height} px
          </div>
        )}
      </div>

      <div
        className="flex-1 min-h-0 flex items-center justify-center p-3 bev-dn overflow-auto"
        style={{
          background: '#0e0d0b',
          backgroundImage:
            'linear-gradient(45deg, #14120f 25%, transparent 25%), linear-gradient(-45deg, #14120f 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #14120f 75%), linear-gradient(-45deg, transparent 75%, #14120f 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
        }}
      >
        <img
          src={src}
          alt={title}
          data-testid="artifact-image-element"
          onLoad={(e) => {
            const img = e.currentTarget;
            setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
          }}
          className={zoomMode === 'fit' ? 'max-w-full max-h-full object-contain select-none' : 'select-none'}
          style={{
            border: '1px solid #2f2f2e',
            display: 'block',
          }}
        />
      </div>
    </div>
  );
};

interface MarkdownViewerProps {
  content: string;
}

const MarkdownViewer: React.FC<MarkdownViewerProps> = ({ content }) => {
  if (!content.trim()) {
    return (
      <div className="text-[12px] italic" style={{ color: 'var(--ink-dim)' }}>
        [Empty artifact. Write markdown, notes, or push content via doom-term-artifact CLI]
      </div>
    );
  }

  const lines = content.split('\n');
  const renderedElements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        renderedElements.push(
          <div key={`code-${i}`} className="my-2 p-2.5 bev-dn" style={{ background: '#100f0d' }}>
            {codeLang && (
              <div className="text-[10px] font-bold mb-1.5" style={{ color: 'var(--ink-dim)' }}>
                {codeLang.toUpperCase()}
              </div>
            )}
            <pre className="text-[11px] font-mono leading-relaxed text-[#e8dbbe] overflow-x-auto select-text">
              <code>{codeBuffer.join('\n')}</code>
            </pre>
          </div>
        );
        codeBuffer = [];
        inCodeBlock = false;
        codeLang = '';
      } else {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Image syntax: ![alt](src)
    const imgMatch = line.trim().match(/^!\[(.*?)\]\((.*?)\)$/);
    if (imgMatch) {
      const alt = imgMatch[1];
      const src = imgMatch[2];
      renderedElements.push(
        <div
          key={i}
          className="my-2 p-2 bev-dn flex flex-col items-center max-w-full"
          style={{ background: '#0e0d0b' }}
          data-testid="markdown-image-container"
        >
          <img
            src={src}
            alt={alt}
            data-testid="markdown-image"
            className="max-w-full h-auto object-contain select-none"
            style={{ border: '1px solid #2f2f2e' }}
            loading="lazy"
          />
          {alt && (
            <span
              className="text-[10px] mt-1.5 select-text"
              style={{ color: 'var(--ink-dim)' }}
            >
              {alt}
            </span>
          )}
        </div>
      );
      continue;
    }

    if (line.startsWith('# ')) {
      renderedElements.push(
        <h1
          key={i}
          className="text-[15px] font-bold mt-3 mb-1.5 pb-1 select-text"
          style={{ color: 'var(--ink)', borderBottom: '1px solid #38342c' }}
        >
          {line.slice(2)}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      renderedElements.push(
        <h2
          key={i}
          className="text-[13px] font-bold mt-2.5 mb-1 pb-0.5 select-text"
          style={{ color: 'var(--ink)', borderBottom: '1px solid #28251f' }}
        >
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      renderedElements.push(
        <h3 key={i} className="text-[12px] font-bold mt-2 mb-1 select-text" style={{ color: 'var(--st-live)' }}>
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith('> [!NOTE]') || line.startsWith('> [!TIP]')) {
      const isTip = line.includes('[!TIP]');
      const color = isTip ? 'var(--st-pass)' : 'var(--st-wait)';
      renderedElements.push(
        <div
          key={i}
          className="my-2 p-2 bev-dn text-[11px] leading-relaxed"
          style={{ background: '#161411', borderLeft: `3px solid ${color}` }}
        >
          <div className="font-bold text-[10px] mb-0.5" style={{ color }}>
            {isTip ? 'TIP' : 'NOTE'}
          </div>
          <div style={{ color: 'var(--ink)' }}>{line.replace(/^>\s*\[!(NOTE|TIP)\]\s*/, '')}</div>
        </div>
      );
    } else if (line.startsWith('> [!WARNING]') || line.startsWith('> [!IMPORTANT]') || line.startsWith('> [!CAUTION]')) {
      const isCaution = line.includes('[!CAUTION]');
      const color = isCaution ? 'var(--st-fail)' : 'var(--st-live)';
      renderedElements.push(
        <div
          key={i}
          className="my-2 p-2 bev-dn text-[11px] leading-relaxed"
          style={{ background: '#161411', borderLeft: `3px solid ${color}` }}
        >
          <div className="font-bold text-[10px] mb-0.5" style={{ color }}>
            {isCaution ? 'CAUTION' : 'IMPORTANT'}
          </div>
          <div style={{ color: 'var(--ink)' }}>
            {line.replace(/^>\s*\[!(WARNING|IMPORTANT|CAUTION)\]\s*/, '')}
          </div>
        </div>
      );
    } else if (line.startsWith('> ')) {
      renderedElements.push(
        <div
          key={i}
          className="my-1.5 pl-2.5 py-0.5 text-[12px] italic select-text"
          style={{ borderLeft: '3px solid var(--st-idle)', color: 'var(--ink-dim)' }}
        >
          {line.slice(2)}
        </div>
      );
    } else if (line.startsWith('- [ ] ') || line.startsWith('- [x] ')) {
      const done = line.startsWith('- [x] ');
      renderedElements.push(
        <div key={i} className="flex items-center gap-2 my-0.5 text-[12px] select-text">
          <span style={{ color: done ? 'var(--st-pass)' : 'var(--ink-dim)' }}>
            {done ? '☒' : '☐'}
          </span>
          <span style={{ color: done ? 'var(--ink-dim)' : 'var(--ink)' }}>
            {line.slice(6)}
          </span>
        </div>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      renderedElements.push(
        <div key={i} className="flex items-start gap-1.5 my-0.5 text-[12px] pl-2 select-text">
          <span style={{ color: 'var(--st-live)' }}>▸</span>
          <span style={{ color: 'var(--ink)' }}>{line.slice(2)}</span>
        </div>
      );
    } else if (line.trim() === '') {
      renderedElements.push(<div key={i} className="h-1.5" />);
    } else {
      renderedElements.push(
        <p key={i} className="text-[12px] leading-relaxed my-0.5 select-text" style={{ color: 'var(--ink)' }}>
          {line}
        </p>
      );
    }
  }

  if (inCodeBlock && codeBuffer.length > 0) {
    renderedElements.push(
      <div key="code-final" className="my-2 p-2.5 bev-dn" style={{ background: '#100f0d' }}>
        <pre className="text-[11px] font-mono leading-relaxed text-[#e8dbbe] overflow-x-auto select-text">
          <code>{codeBuffer.join('\n')}</code>
        </pre>
      </div>
    );
  }

  return <div className="flex flex-col">{renderedElements}</div>;
};
