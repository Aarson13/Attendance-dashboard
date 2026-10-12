import Nav from './components/Nav.jsx';
import Hero from './components/Hero.jsx';
import DashboardPreview from './components/DashboardPreview.jsx';
import Footer from './components/Footer.jsx';

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <DashboardPreview />
      </main>
      <Footer />
    </>
  );
}
