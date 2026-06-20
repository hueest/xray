import { describe, expect, it } from 'vitest'

import { escapeStyleText } from './css-escape.ts'

describe('escapeStyleText', () => {
  it('leaves well-formed plate css byte-for-byte unchanged', () => {
    const css =
      '[data-xr-root] .xr-flex { display: flex }\n@media (min-width: 768px) { x { y: z } }'
    expect(escapeStyleText(css)).toBe(css)
  })

  it('breaks up a </style> terminator (any case) so it cannot close the element', () => {
    expect(escapeStyleText('a</style>b')).not.toMatch(/<\/style/i)
    expect(escapeStyleText('a</STYLE >b')).not.toMatch(/<\/style/i)
    expect(escapeStyleText('a</StYlE>b')).not.toMatch(/<\/style/i)
  })

  it('breaks up HTML comment and CDATA delimiters', () => {
    expect(escapeStyleText('a<!--b')).not.toContain('<!--')
    expect(escapeStyleText('a-->b')).not.toContain('-->')
    expect(escapeStyleText('a<![CDATA[b')).not.toContain('<![CDATA[')
  })

  it('inserts only inert CSS comments, so the result still parses as css', () => {
    // The inserted break is an empty CSS comment; a real stylesheet ignores it.
    const out = escapeStyleText('.x{}</style>')
    expect(out).toContain('/**/')
  })
})
