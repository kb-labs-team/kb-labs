import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { Alert, Button, Card, Empty, Flex, Input, Select, Typography, message } from 'antd';
import { UIPage, UIPageHeader, UIMarkdownViewer, UITree, UISkeleton } from '@kb-labs/sdk/studio';
import type { ArchitectureIndex, ArchitectureNode, ViewerFileEntry } from '../../contracts/index.js';

interface ViewerResponse { architecture: ArchitectureIndex; files: ViewerFileEntry[] }
interface FileResponse { path: string; kind: string; content?: string; data?: string }
interface ConvertedFile { path: string; pdfName: string; data: string }
interface ViewerSource { id: string; title: string }
const API = '/v1/plugins/viewer';

export default function ViewerPage() {
  const [folder, setFolder] = useState('');
  const [source, setSource] = useState('workspace');
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [treeSearch, setTreeSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<string>();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [converted, setConverted] = useState<ConvertedFile>();
  const [diagramHtml, setDiagramHtml] = useState('');
  const [error, setError] = useState<string>();
  const importInput = useRef<HTMLInputElement>(null);
  const { data: sources, refetch: refetchSources } = useViewerRequest<ViewerSource[]>(`${API}/sources`);
  const indexUrl = `${API}/index?${new URLSearchParams({ path: folder, source })}`;
  const { data, isLoading, error: dataError, refetch } = useViewerRequest<ViewerResponse>(indexUrl);
  const filePath = selectedFile;
  const fileUrl = `${API}/file?${new URLSearchParams({ path: filePath ?? '', source })}`;
  const { data: file, isLoading: fileLoading, error: fileError } = useViewerRequest<FileResponse>(
    fileUrl, Boolean(filePath && !['pdf', 'office'].includes(kindFromPath(filePath))),
  );

  const node = data?.architecture.nodes.find((item) => item.id === selectedNodeId);
  const breadcrumbs = useMemo(() => {
    if (!node || !data) {return [];}
    const ancestors: ArchitectureNode[] = [];
    let current: ArchitectureNode | undefined = node;
    while (current) {
      ancestors.unshift(current);
      current = current.parent ? data.architecture.nodes.find((item) => item.id === current?.parent) : undefined;
    }
    return ancestors;
  }, [data, node]);

  useEffect(() => {
    if (!selectedNodeId && data?.architecture.root) {setSelectedNodeId(data.architecture.root);}
  }, [data, selectedNodeId]);

  useEffect(() => {
    if (!data) {return;}
    const nodes = new Map(data.architecture.nodes.map((item) => [item.id, item]));
    const expanded = new Set<string>();
    const query = treeSearch.trim().toLocaleLowerCase();
    const targets = query
      ? data.architecture.nodes.filter((item) => item.title.toLocaleLowerCase().includes(query))
      : [nodes.get(selectedNodeId ?? data.architecture.root)].filter((item): item is ArchitectureNode => Boolean(item));
    for (const target of targets) {
      let current: ArchitectureNode | undefined = target;
      while (current) {
        if (current.children.length > 0) {expanded.add(current.id);}
        current = current.parent ? nodes.get(current.parent) : undefined;
      }
    }
    setExpandedKeys([...expanded]);
  }, [data, selectedNodeId, treeSearch]);

  useEffect(() => {
    let active = true;
    setDiagramHtml('');
    if (!file?.content || !filePath || kindFromPath(filePath) !== 'diagram' || !filePath.match(/\.(mmd|mermaid)$/i)) {return;}
    const diagramContent = file.content;
    void import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
      return mermaid.render(`viewer-${Date.now()}`, diagramContent);
    }).then(({ svg }) => {
      if (active) {setDiagramHtml(svg);}
    }).catch((reason: unknown) => {
      if (active) {setError(reason instanceof Error ? reason.message : 'Не удалось отобразить диаграмму');}
    });
    return () => { active = false; };
  }, [file, filePath]);

  async function openFile(path: string) {
    setSelectedFile(path);
    setConverted(undefined);
    setError(undefined);
    if (kindFromPath(path) === 'pdf') {
      try {
        const result = await requestJson<FileResponse>(`${API}/file?path=${encodeURIComponent(path)}&source=${encodeURIComponent(source)}`);
        setConverted({ path, pdfName: path.split('/').pop() ?? path, data: result.data ?? '' });
      } catch (reason) { setError(errorText(reason)); }
    }
  }

  async function convertOffice() {
    if (!selectedFile) {return;}
    setError(undefined);
    try {
      const result = await requestJson<ConvertedFile>(`${API}/convert?path=${encodeURIComponent(selectedFile)}&source=${encodeURIComponent(source)}`);
      setConverted(result);
    } catch (reason) { setError(errorText(reason)); }
  }

  async function exportPackage() {
    try {
      const result = await requestJson<{ fileName: string; fileCount: number; excludedFiles: number; data: string }>(`${API}/export?source=${encodeURIComponent(source)}`);
      const blob = new Blob([Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0))], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      if (result.excludedFiles > 0) {message.info(`В архив вошло ${result.fileCount} файлов; исключено скрытых или чувствительных: ${result.excludedFiles}.`);}
    } catch (reason) { message.error(`Не удалось экспортировать пакет: ${errorText(reason)}`); }
  }

  async function importPackage(file: File) {
    try {
      if (file.size > 24 * 1024 * 1024) {throw new Error('ZIP архив больше 24 МБ');}
      const data = await readAsBase64(file);
      const imported = await postJson<{ id: string; title: string; fileCount: number; rejectedFiles: number }>(`${API}/import`, { fileName: file.name, data });
      setSource(imported.id);
      setFolder('');
      setSelectedFile(undefined);
      setSelectedNodeId(undefined);
      setConverted(undefined);
      await refetchSources();
      message.success(`Пакет «${imported.title}» импортирован (${imported.fileCount} файлов).`);
      if (imported.rejectedFiles > 0) {message.info(`Не включено скрытых или чувствительных файлов: ${imported.rejectedFiles}.`);}
    } catch (reason) { message.error(`Не удалось импортировать пакет: ${errorText(reason)}`); }
    finally { if (importInput.current) {importInput.current.value = '';} }
  }

  function selectDiagramNode(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) {return;}
    const generatedId = event.target.closest('g.node')?.getAttribute('id') ?? '';
    const matched = data?.architecture.nodes.find((item) => generatedId.includes(`flowchart-${item.id}-`));
    if (matched) {
      setSelectedNodeId(matched.id);
      setSelectedFile(undefined);
      setConverted(undefined);
    }
  }

  const nodeById = new Map(data?.architecture.nodes.map((item) => [item.id, item]) ?? []);
  const rootNode = nodeById.get(data?.architecture.root ?? '');
  const treeData = rootNode ? [toTreeNode(rootNode, nodeById)] : [];
  const currentFiles = data?.files ?? [];
  const visibleFiles = node
    ? [...new Set([...(node.diagram ? [node.diagram] : []), ...node.documents])].map((path) => ({ path, name: path.split('/').pop() ?? path, kind: kindFromPath(path) } as ViewerFileEntry))
    : [];

  return (
    <UIPage>
      <UIPageHeader title="Документы и архитектура" description="Карта системы и проектные материалы" actions={<Flex gap={8}><Select style={{ width: 220 }} value={source} onChange={(value) => { setSource(value); setFolder(''); setSelectedFile(undefined); setSelectedNodeId(undefined); setConverted(undefined); }} options={(sources ?? [{ id: 'workspace', title: 'docs/architecture' }]).map((item) => ({ value: item.id, label: item.title }))} /><Button onClick={() => importInput.current?.click()}>Импортировать ZIP</Button><input ref={importInput} hidden type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) {void importPackage(file);} }} /><Button onClick={exportPackage}>Экспортировать папку</Button></Flex>} />
      {isLoading ? <UISkeleton active lines={8} /> : dataError ? <Alert type="error" showIcon message={`${dataError.code}: ${dataError.message}`} description={<>{dataError.hint}{dataError.correlationId && <div>Correlation ID: {dataError.correlationId}</div>}</>} action={<Button onClick={() => void refetch()}>Повторить</Button>} /> : data ? (
        <Flex gap={16} align="stretch" style={{ minHeight: 600 }}>
          <Card title={data.architecture.title} style={{ width: 340, flex: '0 0 340px', overflow: 'auto' }}>
            <Input allowClear size="small" placeholder="Найти компонент" value={treeSearch} onChange={(event) => setTreeSearch(event.target.value)} style={{ marginBottom: 8 }} />
            <UITree size="md" treeData={treeData} selectedKeys={selectedNodeId ? [selectedNodeId] : []} expandedKeys={expandedKeys} filterTreeNode={(treeNode) => { const item = nodeById.get(String(treeNode.key)); return Boolean(treeSearch.trim() && item?.title.toLocaleLowerCase().includes(treeSearch.trim().toLocaleLowerCase())); }} onExpand={(keys) => setExpandedKeys(keys.map(String))} onSelect={(keys) => { if (keys[0]) { setSelectedNodeId(String(keys[0])); setSelectedFile(undefined); setConverted(undefined); } }} />
            <Typography.Title level={5}>Файлы пакета</Typography.Title>
            {folder && <Button type="link" block style={{ textAlign: 'left' }} onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}>← На уровень выше</Button>}
            {currentFiles.map((item) => <Button key={item.path} type="text" block style={{ textAlign: 'left' }} onClick={() => item.kind === 'directory' ? setFolder(item.path) : void openFile(item.path)}>{item.kind === 'directory' ? '📁 ' : '📄 '}{item.name}</Button>)}
          </Card>
          <Flex vertical gap={16} style={{ flex: 1, minWidth: 0 }}>
            <Card>
              <Flex gap={8} wrap="wrap" align="center">
                {breadcrumbs.map((item, index) => <Button key={item.id} type={index === breadcrumbs.length - 1 ? 'primary' : 'link'} onClick={() => { setSelectedNodeId(item.id); setSelectedFile(undefined); }}>{item.title} <small>{item.level}</small></Button>)}
                <Button type="link" onClick={() => { setFolder(folder ? folder.split('/').slice(0, -1).join('/') : ''); void refetch(); }}>Папка: {folder || 'docs/architecture'}</Button>
              </Flex>
              {node?.summary && <Typography.Paragraph style={{ marginTop: 12 }}>{node.summary}</Typography.Paragraph>}
              {node?.caseRefs.length ? <Typography.Text type="secondary">Связанные кейсы: {node.caseRefs.join(', ')}</Typography.Text> : null}
              {visibleFiles.length > 0 && <Flex gap={8} wrap="wrap" style={{ marginTop: 12 }}>{visibleFiles.map((item) => <Button key={item.path} onClick={() => void openFile(item.path)}>{item.name}</Button>)}</Flex>}
            </Card>
            <Card title={selectedFile ?? node?.title ?? 'Материал'} style={{ flex: 1, minHeight: 420 }}>
              {fileError && <Alert type="error" showIcon message={`${fileError.code}: ${fileError.message}`} description={<>{fileError.hint}{fileError.correlationId && <div>Correlation ID: {fileError.correlationId}</div>}</>} />}
              {error && <Alert type="error" showIcon message={error} />}
              {fileLoading ? <UISkeleton active lines={8} /> : selectedFile ? renderSelected(selectedFile, file, converted, diagramHtml, convertOffice, selectDiagramNode) : <Empty description="Выберите схему или документ узла" />}
            </Card>
          </Flex>
        </Flex>
      ) : <Empty description="Не найден architecture.yaml в выбранном пакете." />}
    </UIPage>
  );
}

function renderSelected(path: string, file: FileResponse | undefined, converted: ConvertedFile | undefined, diagramHtml: string, convertOffice: () => void, selectDiagramNode: (event: MouseEvent<HTMLDivElement>) => void) {
  const kind = kindFromPath(path);
  if (kind === 'office') {return <Flex vertical gap={12}><Typography.Paragraph>Для просмотра документ будет преобразован в PDF. Исходный файл останется без изменений.</Typography.Paragraph><Button type="primary" onClick={convertOffice}>Преобразовать и открыть PDF</Button>{converted && <PdfPreview converted={converted} />}</Flex>;}
  if (kind === 'pdf') {return converted ? <PdfPreview converted={converted} /> : <UISkeleton active lines={8} />;}
  if (kind === 'markdown') {return file?.content ? <UIMarkdownViewer content={file.content} /> : <UISkeleton active lines={8} />;}
  if (kind === 'diagram' && diagramHtml) {return <div onClick={selectDiagramNode} style={{ overflow: 'auto', cursor: 'pointer' }} dangerouslySetInnerHTML={{ __html: `<style>g.node{cursor:pointer}</style>${diagramHtml}` }} />;}
  if (kind === 'diagram') {return file?.content ? <pre style={{ whiteSpace: 'pre-wrap' }}>{file.content}</pre> : <UISkeleton active lines={8} />;}
  return file?.content ? <pre style={{ whiteSpace: 'pre-wrap' }}>{file.content}</pre> : <Empty description="Формат пока можно скачать или открыть через исходный файл" />;
}

function PdfPreview({ converted }: { converted: ConvertedFile }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [pdfError, setPdfError] = useState<string>();
  const url = useMemo(() => {
    const bytes = Uint8Array.from(atob(converted.data), (character) => character.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }, [converted.data]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    let active = true;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    setPdf(undefined);
    setPdfError(undefined);
    setPageNumber(1);
    const data = Uint8Array.from(atob(converted.data), (character) => character.charCodeAt(0));
    void import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      loadingTask = pdfjs.getDocument({ data });
      return loadingTask.promise;
    }).then((document) => {
      if (active) {setPdf(document);}
      else {void document.destroy();}
    }).catch((reason: unknown) => {
      if (active) {setPdfError(errorText(reason));}
    });
    return () => { active = false; void loadingTask?.destroy(); };
  }, [converted.data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas) {return;}
    let cancelled = false;
    const context = canvas.getContext('2d');
    if (!context) { setPdfError('Браузер не поддерживает canvas для просмотра PDF'); return; }
    let renderTask: RenderTask | undefined;
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled) {return;}
      const viewport = page.getViewport({ scale });
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      renderTask = page.render({ canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if (!cancelled) {setPdfError(errorText(reason));}
    });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pdf, pageNumber, scale]);

  return <Flex vertical gap={8} style={{ height: 540 }}>
    <Flex gap={8} wrap="wrap" align="center">
      <Button disabled={!pdf || pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}>Назад</Button>
      <Typography.Text>{pdf ? `${pageNumber} / ${pdf.numPages}` : 'Загрузка PDF…'}</Typography.Text>
      <Button disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => setPageNumber((value) => Math.min(pdf?.numPages ?? value, value + 1))}>Вперёд</Button>
      <Button onClick={() => setScale((value) => Math.max(0.5, value - 0.15))}>−</Button>
      <Typography.Text>{Math.round(scale * 100)}%</Typography.Text>
      <Button onClick={() => setScale((value) => Math.min(2.5, value + 0.15))}>+</Button>
      <Button href={url} download={converted.pdfName}>Скачать PDF</Button>
    </Flex>
    {pdfError && <Typography.Text type="danger">Не удалось отобразить PDF: {pdfError}</Typography.Text>}
    <div style={{ overflow: 'auto', flex: 1, textAlign: 'center', background: '#f3f4f6', padding: 12 }}>
      <canvas ref={canvasRef} aria-label={`PDF, страница ${pageNumber}`} style={{ maxWidth: '100%', height: 'auto', background: 'white', boxShadow: '0 1px 5px #0002' }} />
    </div>
  </Flex>;
}

interface ViewerTreeNode { key: string; title: ReactNode; children: ViewerTreeNode[] }

function toTreeNode(node: ArchitectureNode, nodes: Map<string, ArchitectureNode>): ViewerTreeNode {
  return { key: node.id, title: <span>{node.title} <Typography.Text type="secondary">{node.level}</Typography.Text></span>, children: node.children.map((id) => nodes.get(id)).filter((child): child is ArchitectureNode => Boolean(child)).map((child) => toTreeNode(child, nodes)) };
}

function kindFromPath(path: string): ViewerFileEntry['kind'] {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'mdx') {return 'markdown';}
  if (['mmd', 'mermaid', 'puml', 'plantuml'].includes(ext ?? '')) {return 'diagram';}
  if (ext === 'pdf') {return 'pdf';}
  if (['doc', 'docx'].includes(ext ?? '')) {return 'office';}
  return 'other';
}

interface ViewerFailure { code: string; message: string; hint: string; correlationId?: string }

class ViewerRequestError extends Error {
  constructor(readonly failure: ViewerFailure) { super(failure.message); }
}

function useViewerRequest<T>(url: string, enabled = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ViewerFailure>();
  const [isLoading, setIsLoading] = useState(enabled);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) { setIsLoading(false); return; }
    let active = true;
    setIsLoading(true);
    setError(undefined);
    void requestJson<T>(url).then((result) => {
      if (active) { setData(result); setIsLoading(false); }
    }).catch((reason: unknown) => {
      if (active) { setData(undefined); setError(reason instanceof ViewerRequestError ? reason.failure : { code: 'KB_RUNTIME_UNEXPECTED', message: 'Не удалось загрузить данные Viewer.', hint: 'Повторите запрос. Если ошибка повторится, сообщите администратору проекта.' }); setIsLoading(false); }
    });
    return () => { active = false; };
  }, [enabled, revision, url]);
  return { data, error, isLoading, refetch: async () => { setRevision((value) => value + 1); } };
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(`/api${url}`);
  const json: unknown = await response.json().catch(() => undefined);
  if (isFailure(json)) {throw new ViewerRequestError(json.error);}
  if (!response.ok) {throw new ViewerRequestError({ code: 'KB_RUNTIME_UNEXPECTED', message: 'Запрос Viewer завершился ошибкой.', hint: 'Повторите запрос. Если ошибка повторится, сообщите администратору проекта.' });}
  if (isSuccess<T>(json)) {return json.data;}
  throw new ViewerRequestError({ code: 'KB_RUNTIME_UNEXPECTED', message: 'Viewer вернул ответ неизвестного формата.', hint: 'Обновите страницу и повторите запрос.' });
}

function isFailure(value: unknown): value is { ok: false; error: ViewerFailure } {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== false || !('error' in value)) {return false;}
  const error = value.error;
  return Boolean(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && 'message' in error && typeof error.message === 'string' && 'hint' in error && typeof error.hint === 'string');
}

function isSuccess<T>(value: unknown): value is { ok: true; data: T } {
  return Boolean(value && typeof value === 'object' && 'ok' in value && value.ok === true && 'data' in value);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json: unknown = await response.json().catch(() => undefined);
  if (isFailure(json)) {throw new ViewerRequestError(json.error);}
  if (!response.ok || !isSuccess<T>(json)) {throw new ViewerRequestError({ code: 'KB_RUNTIME_UNEXPECTED', message: 'Запрос Viewer завершился ошибкой.', hint: 'Повторите запрос. Если ошибка повторится, сообщите администратору проекта.' });}
  return json.data;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const separator = result.indexOf(',');
      if (separator < 0) {reject(new Error('Не удалось прочитать ZIP архив'));}
      else {resolve(result.slice(separator + 1));}
    };
    reader.onerror = () => reject(reader.error ?? new Error('Не удалось прочитать ZIP архив'));
    reader.readAsDataURL(file);
  });
}

function errorText(error: unknown) { return error instanceof ViewerRequestError ? `${error.failure.code}: ${error.failure.message} — ${error.failure.hint}` : error instanceof Error ? error.message : 'Неизвестная ошибка'; }
