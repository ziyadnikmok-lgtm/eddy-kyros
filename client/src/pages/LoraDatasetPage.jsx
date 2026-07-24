import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useLoraDatasetProgress } from '../hooks/useLoraDatasetProgress';
import { loraDatasets as loraApi } from '../services/api';
import { IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { Card, Btn, Input, Select, Badge, Empty, Spinner, ProgressBar } from '../components/UI';
function SummaryPill({ label, value }) {
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2">
      <div className="text-[0.625rem] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className="text-sm font-medium text-zinc-200 mt-0.5">{value}</div>
    </div>
  );
}
function PreviewGrid({ items = [] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
      {items.slice(0, 12).map((item) => (
        <div key={item.galleryId} className="rounded-lg overflow-hidden border border-zinc-800/60 bg-zinc-900/40">
          <img src={loraApi.imageUrl(item.galleryId)} alt={item.label} className="h-32 w-full object-cover bg-zinc-950" loading="lazy" />
          <div className="p-2 space-y-1">
            <div className="text-[0.625rem] text-zinc-500 uppercase tracking-wide">{item.shotType === 'face' ? 'Face' : 'Full body'}</div>
            <div className="text-xs text-zinc-300 line-clamp-2">{item.caption || 'Caption pending...'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
export default function LoraDatasetPage() {
  const { notify, characters } = useApp();
  const { loading, run } = useAsync();
  const { dataset: liveDataset, setDataset: setLiveDataset, subscribe, cleanup } = useLoraDatasetProgress();
  const [datasets, setDatasets] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [datasetName, setDatasetName] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [triggerWord, setTriggerWord] = useState('');
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [faceCount, setFaceCount] = useState(15);
  const [fullBodyCount, setFullBodyCount] = useState(15);
  const selectedDataset = useMemo(() => {
    if (liveDataset && liveDataset.id === selectedId) return liveDataset;
    return datasets.find((item) => item.id === selectedId) || liveDataset || datasets[0] || null;
  }, [datasets, selectedId, liveDataset]);
  const loadDatasets = () => {
    loraApi.list().then((data) => {
      setDatasets(data || []);
      if (!selectedId && data?.[0]?.id) setSelectedId(data[0].id);
    }).catch(() => setDatasets([]));
  };
  useEffect(() => {
    loadDatasets();
    return () => cleanup();
  }, []);
  useEffect(() => {
    if (!characterId && characters[0]?.id) setCharacterId(characters[0].id);
  }, [characters, characterId]);
  useEffect(() => {
    if (selectedDataset?.id && selectedDataset.status === 'running') {
      subscribe(selectedDataset.id);
    }
  }, [selectedDataset?.id, selectedDataset?.status, subscribe]);
  useEffect(() => {
    if (liveDataset?.status && liveDataset.status !== 'running') {
      loadDatasets();
    }
  }, [liveDataset?.status]);
  const handleGenerate = () => run(async () => {
    if (!characterId) {
      notify('Select a character first', 'error');
      return;
    }
    if (!triggerWord.trim()) {
      notify('Enter a trigger word for captions', 'error');
      return;
    }
    const created = await loraApi.generate({
      datasetName: datasetName.trim() || undefined,
      characterId,
      triggerWord: triggerWord.trim(),
      imageModel,
      faceCount,
      fullBodyCount,
    });
    if (!created) return;
    setLiveDataset(created);
    setSelectedId(created.id);
    subscribe(created.id);
    loadDatasets();
    notify('LoRA dataset run started', 'success');
  });
  const handleDownload = async (id) => {
    try {
      await loraApi.download(id);
      notify('Dataset ZIP downloaded', 'success');
    } catch (err) {
      notify(err.message || 'Download failed', 'error');
    }
  };
  const progressValue = selectedDataset?.progress?.generated || 0;
  const progressMax = selectedDataset?.progress?.total || 1;
  return (
    <div className="space-y-6 animate-in">
      <Card className="space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">LoRA Dataset Builder</h2>
            <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
              Build captioned LoRA training datasets from saved characters with background execution, live progress, gallery save-as-you-go, and ZIP export.
            </p>
          </div>
          <Badge color="blue">SaaS Background Jobs</Badge>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Select label="Character" value={characterId} onChange={(e) => setCharacterId(e.target.value)} options={[
            { value: '', label: characters.length ? 'Select character...' : 'No characters yet' },
            ...characters.map((char) => ({ value: char.id, label: char.name })),
          ]} />
          <Input label="Trigger Word" placeholder="e.g. lynn37" value={triggerWord} onChange={(e) => setTriggerWord(e.target.value)} />
          <Select label="Image Model" value={imageModel} onChange={(e) => setImageModel(e.target.value)} options={IMAGE_MODEL_OPTIONS} />
          <Input label="Dataset Name" placeholder="Optional custom name" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
          <Input label="Face Images" type="number" min="1" max="15" value={faceCount} onChange={(e) => setFaceCount(Math.max(1, Math.min(15, Number.parseInt(e.target.value || '15', 10))))} />
          <Input label="Full Body Images" type="number" min="1" max="15" value={fullBodyCount} onChange={(e) => setFullBodyCount(Math.max(1, Math.min(15, Number.parseInt(e.target.value || '15', 10))))} />
        </div>
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <Badge color="zinc">Export: images + .txt captions + manifest.json</Badge>
            <span>Face and full-body images are generated separately, and captions always start with your trigger word.</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Btn onClick={handleGenerate} disabled={loading || !characterId || !triggerWord.trim()}>
            {loading ? <Spinner size={16} /> : null}
            Generate Dataset
          </Btn>
          <span className="text-xs text-zinc-500">Runs in background and keeps partial results if some generations fail.</span>
        </div>
      </Card>
      {datasets.length === 0 && !liveDataset ? (
        <Card>
          <Empty icon="atom" title="No LoRA datasets yet" subtitle="Generate one from a saved character to build a captioned training pack." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] gap-6">
          <Card className="space-y-3 h-fit">
            <div className="text-sm font-semibold text-zinc-200">Runs</div>
            <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
              {[...(liveDataset && !datasets.find((d) => d.id === liveDataset.id) ? [liveDataset] : []), ...datasets].map((dataset) => (
                <button key={dataset.id} onClick={() => setSelectedId(dataset.id)} className={dataset.id === selectedId ? 'w-full cursor-pointer rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-left transition' : 'w-full cursor-pointer rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3 text-left transition hover:border-zinc-700/80 hover:bg-zinc-900/50'}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-zinc-200 truncate">{dataset.name}</div>
                    <Badge color={dataset.status === 'completed' ? 'green' : dataset.status === 'running' ? 'blue' : dataset.status === 'partial' ? 'yellow' : 'red'}>{dataset.status}</Badge>
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">{dataset.characterName}</div>
                  <div className="text-xs text-zinc-500 mt-1">{dataset.progress?.generated || 0}/{dataset.progress?.total || dataset.requested?.total || 0} generated ? {dataset.stage || 'queued'}</div>
                </button>
              ))}
            </div>
          </Card>
          {selectedDataset && (
            <Card className="space-y-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-100">{selectedDataset.name}</h3>
                  <div className="text-sm text-zinc-500 mt-1">{selectedDataset.characterName} ? {selectedDataset.imageModel} ? trigger "{selectedDataset.triggerWord}"</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge color={selectedDataset.status === 'completed' ? 'green' : selectedDataset.status === 'running' ? 'blue' : selectedDataset.status === 'partial' ? 'yellow' : 'red'}>{selectedDataset.stage || selectedDataset.status}</Badge>
                  <Btn onClick={() => handleDownload(selectedDataset.id)} disabled={!selectedDataset.items?.length}>Download ZIP</Btn>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span>Generation progress</span>
                  <span>{progressValue} / {progressMax}</span>
                </div>
                <ProgressBar value={progressValue} max={progressMax} />
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <SummaryPill label="Generated" value={selectedDataset.progress?.generated || 0} />
                <SummaryPill label="Captioned" value={selectedDataset.progress?.captioned || 0} />
                <SummaryPill label="Failed" value={selectedDataset.progress?.failed || 0} />
                <SummaryPill label="Requested" value={selectedDataset.requested?.total || 0} />
                <SummaryPill label="Created" value={new Date(selectedDataset.createdAt).toLocaleDateString()} />
              </div>
              <PreviewGrid items={selectedDataset.items || []} />
              {selectedDataset.failures?.length > 0 && (
                <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-4">
                  <div className="text-sm font-medium text-yellow-300 mb-2">Failures</div>
                  <div className="space-y-1.5">
                    {selectedDataset.failures.slice(0, 10).map((failure, idx) => (
                      <div key={`${failure.label || failure.stage}-${idx}`} className="text-xs text-yellow-100/80">
                        {(failure.label || failure.stage || 'step')}: {failure.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
