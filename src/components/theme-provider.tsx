"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

const themeMigrationScript = `(() => {
  try {
    const stored = window.localStorage.getItem('theme')
    const theme = stored === 'light' ? 'light' : stored === 'dark' || stored === 'blue' || stored === 'purple' ? 'dark' : 'light'
    window.localStorage.setItem('theme', theme)
    document.documentElement.classList.remove('dark')
    document.documentElement.setAttribute('data-theme', theme)
  } catch {
    document.documentElement.classList.remove('dark')
    document.documentElement.setAttribute('data-theme', 'light')
  }
})()`

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: themeMigrationScript }} />
      <NextThemesProvider {...props}>{children}</NextThemesProvider>
    </>
  )
}
