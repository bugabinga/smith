//! Prototype: ratatui + crossterm basic TUI with mouse support.

use crossterm::{
    event::{self, Event, KeyCode, MouseEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    execute,
};
use ratatui::{backend::CrosstermBackend, layout::{Constraint, Layout, Direction}, widgets::{Block, Borders, Paragraph, List, ListItem}, style::{Style, Color}, text::Span};
use std::io;

fn main() -> io::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = ratatui::Terminal::new(backend)?;

    let mut counter: i32 = 0;
    let mut clicks: Vec<String> = Vec::new();
    let mut mouse_pos: (u16, u16) = (0, 0);

    // Run for max 3 seconds or until 'q'
    loop {
        terminal.draw(|f| {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(3), Constraint::Length(5), Constraint::Min(1)].as_ref())
                .split(f.area());

            // Sticky header
            let header = Paragraph::new(Span::styled(
                format!("smith prototype TUI | counter={} | mouse=({},{}), clicks={}",
                    counter, mouse_pos.0, mouse_pos.1, clicks.len()),
                Style::default().fg(Color::Green),
            ))
            .block(Block::default().borders(Borders::ALL).title("Header (sticky)"));
            f.render_widget(header, chunks[0]);

            // Click log
            let items: Vec<ListItem> = clicks.iter()
                .map(|c| ListItem::new(c.as_str()))
                .collect();
            let log = List::new(items)
                .block(Block::default().borders(Borders::ALL).title("Mouse clicks"));
            f.render_widget(log, chunks[1]);

            // Footer
            let footer = Paragraph::new("j/k=inc/dec q=quit click=log")
                .block(Block::default().borders(Borders::ALL).title("Footer"));
            f.render_widget(footer, chunks[2]);
        })?;

        if event::poll(std::time::Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                match key.code {
                    KeyCode::Char('q') => break,
                    KeyCode::Char('j') => counter += 1,
                    KeyCode::Char('k') => counter -= 1,
                    _ => {}
                }
            } else if let Event::Mouse(mouse) = event::read()? {
                mouse_pos = (mouse.column, mouse.row);
                match mouse.kind {
                    MouseEventKind::Down(_) => {
                        clicks.push(format!("({},{}), mods={:?}", mouse.column, mouse.row, mouse.modifiers));
                    }
                    MouseEventKind::ScrollUp => counter += 1,
                    MouseEventKind::ScrollDown => counter -= 1,
                    _ => {}
                }
            }
        } else {
            break; // timeout
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    println!("TUI test complete. Counter={}, clicks={}", counter, clicks.len());
    Ok(())
}
