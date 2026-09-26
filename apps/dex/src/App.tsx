import { Outlet, Route, Routes } from 'react-router-dom'

import Activity from '@/app/activity/page'
import Agents from '@/app/agents/page'
import Buckets from '@/app/buckets/page'
import NewBucketPermission from '@/app/buckets/new/page'
import Onboard from '@/app/onboard/page'
import Landing from '@/app/page'
import Pay from '@/app/pay/page'
import Portfolio from '@/app/portfolio/page'
import Rale from '@/app/rale/page'
import Trade from '@/app/trade/page'
import { Nav } from '@/components/nav'

function Shell() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        <Outlet />
      </main>
      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 pb-10 pt-4 text-xs text-faint md:px-8">
        <span>BUCKET · self-custodial capability protocol</span>
        <span>ENSv2 on EVM · SuiNS on Sui · testnets only</span>
      </footer>
    </>
  )
}

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Landing />} />
        <Route path="onboard" element={<Onboard />} />
        <Route path="trade" element={<Trade />} />
        <Route path="pay" element={<Pay />} />
        <Route path="agents" element={<Agents />} />
        <Route path="buckets" element={<Buckets />} />
        <Route path="buckets/new" element={<NewBucketPermission />} />
        <Route path="portfolio" element={<Portfolio />} />
        <Route path="activity" element={<Activity />} />
        <Route path="rale" element={<Rale />} />
      </Route>
    </Routes>
  )
}
