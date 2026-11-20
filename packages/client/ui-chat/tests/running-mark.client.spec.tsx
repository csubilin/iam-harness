// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningMark } from '../src/client/chat/RunningMark.tsx'

afterEach(cleanup)

describe('RunningMark', () => {
  it('renders the decorative IAM mark without inline styles', () => {
    const view = render(<RunningMark />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    const mark = icon.firstElementChild!
    expect(mark.tagName).toBe('SPAN')
    const svg = mark.querySelector('svg')!
    expect(mark.firstElementChild).toBe(svg)
    expect(svg.getAttribute('viewBox')).toBe('0 0 512 512')
    expect(svg.querySelectorAll('path')).toHaveLength(4)
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#078FCB')
    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })
})
