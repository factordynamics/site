import { SearchBox } from '../components/Search'
import { Button } from '../components/ui'

export function NotFound() {
  return (
    <div className="container-x max-w-xl pt-24 text-center">
      <p className="font-mono text-[13px] text-ink-3">404</p>
      <h1 className="mt-3 text-[36px] font-semibold tracking-[-0.04em]">This page isn’t in the filing.</h1>
      <p className="mt-3 text-[16px] text-ink-2">Search for an investor or head back home.</p>
      <div className="mt-8 text-left">
        <SearchBox size="lg" />
      </div>
      <Button to="/" variant="ghost" className="mt-6">
        Back to Copybook
      </Button>
    </div>
  )
}
