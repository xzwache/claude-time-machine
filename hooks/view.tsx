// What the time machine draws, as plain views: the band above the prompt and
// the pane. They take the surface's element table, the values to show and
// the handlers to call; register.tsx reads the state and owns the handlers.

import type { EngineInterface, RenderElement } from 'claude-code'

import { clip, countsShort, entryLine, hunksOf, kindLabel, oneLine, statusMark, stepLabel } from './format.ts'
import type { Band, Details, Entry } from '../types'

type Table = ReturnType<EngineInterface['ui']['resolve']>

export type BandHandlers = {
  undo: () => void
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
    <Box flexDirection="row" gap={1}>
      <Text dimColor>{clip(`⏱ Claude changed ${shown.summary}`, Math.max(10, columns - 34))}</Text>
      <Button key="tm-undo" variant="primary" hotkey="u" label="Undo turn" onPress={on.undo} />
      <Button key="tm-review" hotkey="r" label="Review" onPress={on.review} />
      {close}
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
  const entry = list.find(one => one.id === chosen)
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
      {list.slice(0, room).map((one, i) => row(`e-${i}`, one.id === chosen, `${i + 1}. ${entryLine(one)}`, () => on.select(one.id)))}
      {entry && shown && focus && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{clip(`${kindLabel(entry)} · ${entry.title}`, columns)}</Text>
          {entry.prompt !== '' && entry.prompt !== entry.title && <Text dimColor>{clip(`› ${oneLine(entry.prompt)}`, columns * 2)}</Text>}
          {entry.answer !== '' && <Text dimColor>{clip(`‹ ${oneLine(entry.answer)}`, columns * 2)}</Text>}
          {shown.steps.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {row('s-all', shown.id === entry.id, `whole turn  ${countsShort(entry)}`, () => on.showStep(entry.id))}
              {shown.steps.slice(0, 15).map((step, i) =>
                row(`s-${i}`, shown.id === step.id, `  ${i + 1}. ${stepLabel(step)}  ${countsShort(step)}`, () => on.showStep(step.id)),
              )}
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            {shown.changes.length === 0 && <Text dimColor>No file changes.</Text>}
            {shown.changes.slice(0, 30).map((change, i) =>
              row(`f-${i}`, change.path === shown.file, `${statusMark(change)} ${change.path}`, () => on.showFile(change.path)),
            )}
            {shown.changes.length > 30 && <Text dimColor>…and {shown.changes.length - 30} more</Text>}
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

function diffView(table: Table, diff: string, path: string): RenderElement {
  const { Code, Text } = table
  const hunks = hunksOf(diff)
  if (hunks === undefined) return <Text dimColor>Binary file, or only its mode changed.</Text>
  if (hunks === '') return <Text dimColor>Diff too large to show here: see /tm git.</Text>

  return <Code source={hunks} format="diff" path={path} />
}
