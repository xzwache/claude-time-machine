// What the time machine draws, as plain views: the band above the prompt and
// the pane. They take the surface's element table, the values to show and
// the handlers to call; register.tsx reads the state and owns the handlers.

import type { EngineInterface, RenderElement, RenderSurface } from 'claude-code'

import { clip, countsShort, entryLine, hunksOf, kindLabel, oneLine, statusMark, stepLabel } from './format.ts'
import { METRICS, METRIC_LABELS, METRIC_UNITS, describe, valueLabel } from './heat.ts'
import { kindOfPath } from './sensitive.ts'
import { heatColor, hex, intensity, maxValue, rasterCells, svgTreemap } from './treemap.ts'
import type { Band, Details, Entry, HeatMetric, HeatNode, HeatView } from '../types'

type Table = ReturnType<EngineInterface['ui']['resolve']>

export type BandHandlers = {
  undo: () => void
  undoSensitive: () => void
  review: () => void
  close: () => void
}

export function bandView(table: Table, shown: Band, columns: number, on: BandHandlers): RenderElement {
  const { Box, Text, Button } = table
  const close = <Button key="tm-close" role="dismiss" label="×" onPress={on.close} />

  if (shown.result !== null) {
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="green">{clip(shown.result, columns - 6)}</Text>
        {close}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{clip(`⏱ Claude changed ${shown.summary}`, Math.max(10, columns - 34))}</Text>
        <Button key="tm-undo" variant="primary" hotkey="u" label="Undo turn" onPress={on.undo} />
        <Button key="tm-review" hotkey="r" label="Review" onPress={on.review} />
        {close}
      </Box>
      {shown.alert !== null && (
        <Box flexDirection="row" gap={1}>
          <Text color="yellow">{clip(`⚠ ${shown.alert}`, Math.max(10, columns - 18))}</Text>
          <Button key="tm-undo-sensitive" hotkey="x" label="Undo these" onPress={on.undoSensitive} />
        </Box>
      )}
    </Box>
  )
}

export type PaneData = {
  list: Entry[]
  chosen: string | null
  shown: Details | null
  asked: string | null
  notice: string
  columns: number
  rows: number
}

export type PaneHandlers = {
  select: (id: string) => void
  showStep: (id: string) => void
  showFile: (path: string) => void
  perform: (action: 'undo' | 'before' | 'after', entry: Entry) => void
}

export function paneView(table: Table, data: PaneData, on: PaneHandlers): RenderElement {
  const { Box, Text, Button } = table
  const { list, chosen, shown, asked, columns } = data
  const room = Math.max(4, Math.min(12, Math.floor((data.rows - 8) / 3)))
  const entry = list.find(one => one.id === chosen) ?? (shown?.entry?.id === chosen ? shown.entry : undefined)
  const focus = shown?.id === entry?.id ? entry : shown?.steps.find(step => step.id === shown.id)
  const row = (key: string, isOn: boolean, label: string, onPress: () => void) => (
    <Button key={key} plain dimColor={!isOn} label={clip(`${isOn ? '▸' : ' '} ${label}`, columns)} onPress={onPress} />
  )
  const travel = (where: 'before' | 'after', id: string) =>
    asked === `${where}:${id}` ? `Confirm: travel ${where}` : `Travel to ${where}`

  return (
    <Box flexDirection="column">
      {data.notice !== '' && <Text color="yellow">{clip(data.notice, columns)}</Text>}
      {list.length === 0 && <Text dimColor>No snapshots yet. They appear after Claude changes files.</Text>}
      {list
        .slice(0, room)
        .map((one, i) => row(`e-${i}`, one.id === chosen, `${i + 1}. ${entryLine(one)}`, () => on.select(one.id)))}
      {entry && shown && focus && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{clip(`${kindLabel(entry)} · ${entry.title}`, columns)}</Text>
          {entry.prompt !== '' && entry.prompt !== entry.title && (
            <Text dimColor>{clip(`› ${oneLine(entry.prompt)}`, columns * 2)}</Text>
          )}
          {entry.answer !== '' && <Text dimColor>{clip(`‹ ${oneLine(entry.answer)}`, columns * 2)}</Text>}
          {shown.steps.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {row('s-all', shown.id === entry.id, `whole turn  ${countsShort(entry)}`, () => on.showStep(entry.id))}
              {shown.steps
                .slice(0, 15)
                .map((step, i) =>
                  row(`s-${i}`, shown.id === step.id, `  ${i + 1}. ${stepLabel(step)}  ${countsShort(step)}`, () =>
                    on.showStep(step.id),
                  ),
                )}
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            {shown.changes.length === 0 && <Text dimColor>No file changes.</Text>}
            {shown.changes
              .slice(0, 30)
              .map((change, i) =>
                row(
                  `f-${i}`,
                  change.path === shown.file,
                  `${statusMark(change)} ${change.path}${flag(change.path)}`,
                  () => on.showFile(change.path),
                ),
              )}
            {shown.changes.length + shown.more > 30 && (
              <Text dimColor>…and {shown.changes.length + shown.more - 30} more</Text>
            )}
          </Box>
          {focus.parent !== null && (
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Button
                key="undo"
                variant="primary"
                label={focus.id === entry.id ? 'Undo this' : 'Undo this step'}
                onPress={() => on.perform('undo', focus)}
              />
              <Button key="before" label={travel('before', focus.id)} onPress={() => on.perform('before', focus)} />
              <Button key="after" label={travel('after', focus.id)} onPress={() => on.perform('after', focus)} />
            </Box>
          )}
          {shown.file !== null && diffView(table, shown.diff, shown.file)}
        </Box>
      )}
    </Box>
  )
}

function flag(path: string): string {
  return kindOfPath(path) === undefined ? '' : '  ⚠'
}

function diffView(table: Table, diff: string, path: string): RenderElement {
  const { Code, Text } = table
  const hunks = hunksOf(diff)
  if (hunks === undefined) return <Text dimColor>Binary file, or only its mode changed.</Text>
  if (hunks === '') return <Text dimColor>Diff too large to show here: see /tm git.</Text>

  return <Code source={hunks} format="diff" path={path} />
}

export type HeatHandlers = {
  metric: (metric: HeatMetric) => void
  enter: (node: HeatNode) => void
  up: (path: string) => void
  openPage: () => void
  openTurn: (id: string) => void
  closeFile: () => void
}

const MAP_ROWS = 18
const LISTED = 12

export function heatView(
  table: Table,
  surface: RenderSurface,
  view: HeatView,
  columns: number,
  rows: number,
  on: HeatHandlers,
): RenderElement {
  const { Box, Text, Button, Markdown } = table
  const { nodes, metric, parent } = view
  const max = maxValue(nodes, metric)
  const since = new Date(view.since).toISOString().slice(0, 10)
  const legend =
    metric === 'owner'
      ? 'blue: others · grey: both · orange: Claude'
      : `${METRIC_LABELS[metric]}: dark none → yellow most`

  return (
    <Box flexDirection="column">
      <Text bold>{clip(`${view.path === '' ? 'project' : `${view.path}/`}  ·  ${describe(view.total)}`, columns)}</Text>
      <Text dimColor>{clip(`${view.turns} Claude turns since ${since} · size: lines changed`, columns)}</Text>
      <Box flexDirection="row" gap={1} marginTop={1}>
        {METRICS.map((one, i) => (
          <Button
            key={`m-${one}`}
            hotkey={String(i + 1)}
            variant={one === metric ? 'primary' : undefined}
            label={METRIC_LABELS[one]}
            onPress={() => on.metric(one)}
          />
        ))}
        {parent !== null && <Button key="up" hotkey="b" label="↑ Up" onPress={() => on.up(parent)} />}
        <Button key="open" hotkey="o" label="Open in browser" onPress={on.openPage} />
      </Box>
      <Box marginTop={1}>
        {mapView(table, surface, nodes, metric, columns, Math.max(6, Math.min(MAP_ROWS, rows - LISTED - 10)))}
      </Box>
      <Text dimColor>{clip(legend, columns)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {nodes.slice(0, LISTED).map((node, i) => {
          const name = `${node.isDir ? '▸' : ' '} ${node.name}${node.isDir ? '/' : ''}`
          const shown = metric === 'churn' ? '' : `${valueLabel(node, metric, METRIC_UNITS)} · `
          return (
            <Box key={`row-${i}`} flexDirection="row" gap={1}>
              <Text color={hex(heatColor(intensity(node, metric, max), metric))}>██</Text>
              <Button
                key={`n-${i}`}
                plain
                label={clip(`${name}  ${shown}${describe(node)}`, Math.max(10, columns - 4))}
                onPress={() => on.enter(node)}
              />
            </Box>
          )
        })}
        {nodes.length > LISTED && <Text dimColor>…and {nodes.length - LISTED} more</Text>}
      </Box>
      {view.file !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold>{clip(view.file.path, columns - 4)}</Text>
            <Button key="file-close" role="dismiss" label="×" onPress={on.closeFile} />
          </Box>
          {view.file.turns.length === 0 && <Text dimColor>No closed Claude turn changed it in this window.</Text>}
          {view.file.turns.map((turn, i) => (
            <Button
              key={`t-${i}`}
              plain
              label={clip(`↳ ${clock(turn.time)} ${turn.title}`, columns)}
              onPress={() => on.openTurn(turn.id)}
            />
          ))}
        </Box>
      )}
      {view.notice !== '' && <Text color="yellow">{clip(view.notice, columns * 2)}</Text>}
      {view.page !== null && <Markdown text={`[Open the interactive map](${fileUrl(view.page)})`} />}
    </Box>
  )
}

function mapView(
  table: Table,
  surface: RenderSurface,
  nodes: readonly HeatNode[],
  metric: HeatMetric,
  columns: number,
  rows: number,
): RenderElement {
  // The element table answers `in` for every name; the surface says what it draws.
  if (surface === 'terminal' && 'Raster' in table) {
    const width = Math.min(512, Math.max(10, columns))
    const { Raster } = table
    return <Raster key="heat-map" columns={width} rows={rows} cells={rasterCells(nodes, metric, width, rows)} />
  }
  if (!('Svg' in table)) throw new Error(`No treemap element on ${surface}`)
  const { Svg } = table
  const alt = `Treemap of ${nodes.length} entries by ${METRIC_LABELS[metric]}`
  return <Svg source={svgTreemap(nodes, metric, 720, 360)} alt={alt} isInteractive />
}

function clock(time: number): string {
  const date = new Date(time)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function fileUrl(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}
