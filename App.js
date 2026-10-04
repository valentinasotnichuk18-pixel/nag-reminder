import { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet, Text, TextInput, Pressable, View, FlatList, Keyboard, Alert,
  ScrollView, Switch,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Notifications from 'expo-notifications';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

const db = SQLite.openDatabaseSync('tasks.db');

db.execSync(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Міграція: додаємо колонку deadline, якщо її ще немає
const taskColumns = db.getAllSync('PRAGMA table_info(tasks)');
if (!taskColumns.some((c) => c.name === 'deadline')) {
  db.execSync('ALTER TABLE tasks ADD COLUMN deadline TEXT');
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNEL_ID = 'reminders';
const CATEGORY_ID = 'task';
const UNDO_SECONDS = 6;
const SNOOZE_MIN = 15;
const SNOOZE_PREFIX = 'snooze-';
const MAX_SUMMARY_TIMES = 6;
const MAX_SUMMARY_LINES = 8;

const INTERVALS = [
  { min: 15, label: '15 хв' },
  { min: 30, label: '30 хв' },
  { min: 60, label: '1 год' },
  { min: 120, label: '2 год' },
  { min: 180, label: '3 год' },
];

const SUMMARY_INTERVALS = [
  { min: 120, label: '2 год' },
  { min: 180, label: '3 год' },
  { min: 240, label: '4 год' },
];

const DEADLINE_DAYS = [
  { key: 'none', label: 'Без дедлайну' },
  { key: 'today', label: 'Сьогодні' },
  { key: 'tomorrow', label: 'Завтра' },
  { key: 'pick', label: 'Обрати дату' },
];

function nagTitle(order) {
  if (order <= 1) return 'Нагадую';
  if (order <= 3) return 'Знову нагадую';
  if (order <= 6) return 'Я не відстану';
  return 'Ну досить відкладати!';
}

// ---------- Дата і час ----------

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(d) {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

function minutesLabel(total) {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function modeForDate(d) {
  if (!d) return 'none';
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (isSameDay(d, now)) return 'today';
  if (isSameDay(d, tomorrow)) return 'tomorrow';
  return 'pick';
}

function deadlineInfo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const time = formatTime(d);

  if (d < now) return { text: 'прострочено', overdue: true };

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (isSameDay(d, now)) return { text: `до ${time}`, overdue: false };
  if (isSameDay(d, tomorrow)) return { text: `завтра до ${time}`, overdue: false };
  return { text: `${formatDate(d)} до ${time}`, overdue: false };
}

function openPicker({ value, mode, minimumDate, onPick }) {
  DateTimePickerAndroid.open({
    value,
    mode,
    is24Hour: true,
    minimumDate,
    onValueChange: (...args) => {
      const date = args.find((a) => a instanceof Date);
      if (date) onPick(date);
    },
    onDismiss: () => {},
  });
}

// ---------- База ----------

function getSetting(key, defaultValue) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', key);
  return row ? Number(row.value) : defaultValue;
}

function getSettingText(key, defaultValue) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.runSync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    key,
    String(value)
  );
}

function parseTimes(text) {
  return text
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

function loadSettings() {
  const oldStart = getSetting('start_hour', 8) * 60;
  const oldEnd = getSetting('end_hour', 22) * 60;
  return {
    intervalMin: getSetting('interval_min', 60),
    startMin: getSetting('start_min', oldStart),
    endMin: getSetting('end_min', oldEnd),
    summaryEnabled: getSetting('summary_enabled', 1) === 1,
    summaryMode: getSettingText('summary_mode', 'interval'),
    summaryIntervalMin: getSetting('summary_interval', 180),
    summaryTimes: parseTimes(getSettingText('summary_times', '540,780,1080')),
  };
}

function loadTasks() {
  return db.getAllSync(
    "SELECT id, title, deadline FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
}

function intervalLabel(min) {
  const found = INTERVALS.find((i) => i.min === min);
  return found ? found.label : `${min} хв`;
}

// ---------- Розклад нагадувань ----------

function slotsFor(createdAtIso, s) {
  const created = new Date(createdAtIso);
  const base = created.getHours() * 60 + created.getMinutes();
  const slots = [];
  for (let m = base % s.intervalMin; m < 24 * 60; m += s.intervalMin) {
    if (m >= s.startMin && m <= s.endMin) {
      const offset = (m - base + 1440) % 1440 || 1440;
      slots.push({ hour: Math.floor(m / 60), minute: m % 60, offset });
    }
  }
  slots.sort((a, b) => a.offset - b.offset);
  return slots.map((slot, i) => ({ ...slot, order: i + 1 }));
}

function countReminders(createdIso, doneIso, s) {
  const created = new Date(createdIso);
  const done = new Date(doneIso);
  const slots = slotsFor(createdIso, s);
  let count = 0;
  const day = new Date(created);
  day.setHours(0, 0, 0, 0);
  while (day <= done) {
    for (const slot of slots) {
      const t = new Date(day);
      t.setHours(slot.hour, slot.minute, 0, 0);
      if (t > created && t <= done) count += 1;
    }
    day.setDate(day.getDate() + 1);
  }
  return count;
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return 'менше хвилини';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days} дн`);
  if (hours) parts.push(`${hours} год`);
  if (mins && !days) parts.push(`${mins} хв`);
  return parts.join(' ');
}

function remindersWord(n) {
  return n % 10 === 1 && n % 100 !== 11 ? 'нагадування' : 'нагадувань';
}

function doneSummary(task) {
  const duration = formatDuration(new Date(task.done_at) - new Date(task.created_at));
  const count = countReminders(task.created_at, task.done_at, loadSettings());
  if (count === 0) return `за ${duration}, без жодного нагадування`;
  return `за ${duration}, після ${count} ${remindersWord(count)}`;
}

// ---------- Зведення ----------

// Коли надсилати зведення (хвилини від початку доби)
function summarySlots(s) {
  if (!s.summaryEnabled) return [];
  if (s.summaryMode === 'times') {
    return [...new Set(s.summaryTimes)].sort((a, b) => a - b);
  }
  const slots = [];
  for (let m = s.startMin; m <= s.endMin; m += s.summaryIntervalMin) slots.push(m);
  return slots;
}

function summaryLabel(s) {
  if (!s.summaryEnabled) return 'вимкнено';
  if (s.summaryMode === 'times') {
    return `о ${summarySlots(s).map(minutesLabel).join(', ')}`;
  }
  return `кожні ${s.summaryIntervalMin / 60} год`;
}

function tasksWord(n) {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return 'справа чекає';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'справи чекають';
  return 'справ чекають';
}

function loadSummaryTasks() {
  // Спочатку з найближчим дедлайном, потім без дедлайну
  return db.getAllSync(
    "SELECT title, deadline FROM tasks WHERE status = 'active' ORDER BY deadline IS NULL, deadline, id"
  );
}

function summaryContent(list) {
  const lines = list.slice(0, MAX_SUMMARY_LINES).map((t, i) => {
    if (!t.deadline) return `${i + 1}. ${t.title}`;
    const d = new Date(t.deadline);
    return `${i + 1}. ${t.title} · до ${formatDate(d)} ${formatTime(d)}`;
  });
  if (list.length > MAX_SUMMARY_LINES) {
    lines.push(`і ще ${list.length - MAX_SUMMARY_LINES}`);
  }
  return {
    title: `${list.length} ${tasksWord(list.length)}`,
    body: lines.join('\n'),
    data: { type: 'summary' },
  };
}

// ---------- Сповіщення ----------

async function setupNotifications() {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Нагадування',
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    {
      identifier: 'done',
      buttonTitle: 'Готово',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'snooze',
      buttonTitle: `Через ${SNOOZE_MIN} хв`,
      options: { opensAppToForeground: true },
    },
  ]);
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Сповіщення вимкнені',
      'Без дозволу на сповіщення нагадування не приходитимуть. Увімкни їх у налаштуваннях телефона.'
    );
  }
}

function notificationBody(task) {
  if (!task.deadline) return task.title;
  const d = new Date(task.deadline);
  return `${task.title} · дедлайн ${formatDate(d)} о ${formatTime(d)}`;
}

async function doReschedule() {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    if (!n.identifier.startsWith(SNOOZE_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
    }
  }

  const s = loadSettings();
  const active = db.getAllSync(
    "SELECT id, title, created_at, deadline FROM tasks WHERE status = 'active'"
  );

  // Нагадування про кожне завдання
  for (const t of active) {
    for (const slot of slotsFor(t.created_at, s)) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: nagTitle(slot.order),
          body: notificationBody(t),
          data: { taskId: t.id },
          categoryIdentifier: CATEGORY_ID,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: slot.hour,
          minute: slot.minute,
          channelId: CHANNEL_ID,
        },
      });
    }
  }

  // Зведення (тільки якщо є активні завдання)
  if (active.length > 0) {
    const content = summaryContent(loadSummaryTasks());
    for (const m of summarySlots(s)) {
      await Notifications.scheduleNotificationAsync({
        content,
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: Math.floor(m / 60),
          minute: m % 60,
          channelId: CHANNEL_ID,
        },
      });
    }
  }
}

let rescheduleChain = Promise.resolve();
function rescheduleAll() {
  rescheduleChain = rescheduleChain.then(doReschedule).catch(console.warn);
  return rescheduleChain;
}

async function dismissTaskNotifications(taskId) {
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const n of presented) {
    if (n.request.content.data?.taskId === taskId) {
      await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  }
}

async function cancelSnooze(taskId) {
  try {
    await Notifications.cancelScheduledNotificationAsync(`${SNOOZE_PREFIX}${taskId}`);
  } catch (e) {
    // відкладеного нагадування не було, нічого страшного
  }
}

async function snoozeTask(taskId) {
  const t = db.getFirstSync(
    "SELECT id, title, deadline FROM tasks WHERE id = ? AND status = 'active'",
    taskId
  );
  await dismissTaskNotifications(taskId);
  if (!t) return null;
  await cancelSnooze(taskId);
  await Notifications.scheduleNotificationAsync({
    identifier: `${SNOOZE_PREFIX}${taskId}`,
    content: {
      title: 'Відпочила? Повертаюсь',
      body: notificationBody(t),
      data: { taskId: t.id },
      categoryIdentifier: CATEGORY_ID,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: SNOOZE_MIN * 60,
      channelId: CHANNEL_ID,
    },
  });
  return t;
}

async function completeTask(taskId) {
  const result = db.runSync(
    "UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'active'",
    new Date().toISOString(),
    taskId
  );
  await dismissTaskNotifications(taskId);
  await cancelSnooze(taskId);
  await rescheduleAll();
  if (result.changes === 0) return null;
  return db.getFirstSync(
    'SELECT id, title, created_at, done_at FROM tasks WHERE id = ?',
    taskId
  );
}

async function undoTask(taskId) {
  db.runSync(
    "UPDATE tasks SET status = 'active', done_at = NULL WHERE id = ?",
    taskId
  );
  await rescheduleAll();
}

async function deleteTask(taskId) {
  db.runSync('DELETE FROM tasks WHERE id = ?', taskId);
  await dismissTaskNotifications(taskId);
  await cancelSnooze(taskId);
  await rescheduleAll();
}

async function sendTestNotification() {
  const t = db.getFirstSync(
    "SELECT id, title, deadline FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
  if (!t) {
    Alert.alert('Немає завдань', 'Спочатку додай хоча б одне завдання.');
    return;
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${nagTitle(4)} (тест)`,
      body: notificationBody(t),
      data: { taskId: t.id },
      categoryIdentifier: CATEGORY_ID,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      channelId: CHANNEL_ID,
    },
  });
  Alert.alert('Тест', 'Згорни застосунок, сповіщення прийде через 10 секунд.');
}

async function sendTestSummary() {
  const list = loadSummaryTasks();
  if (list.length === 0) {
    Alert.alert('Немає завдань', 'Зведення приходить, тільки коли є активні завдання.');
    return;
  }
  const content = summaryContent(list);
  await Notifications.scheduleNotificationAsync({
    content: { ...content, title: `${content.title} (тест)` },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      channelId: CHANNEL_ID,
    },
  });
  Alert.alert('Тест', 'Згорни застосунок, зведення прийде через 10 секунд.');
}

// ---------- Екрани ----------

function TimeField({ label, value, onChange }) {
  const open = () => {
    const d = new Date();
    d.setHours(Math.floor(value / 60), value % 60, 0, 0);
    openPicker({
      value: d,
      mode: 'time',
      onPick: (date) => onChange(date.getHours() * 60 + date.getMinutes()),
    });
  };

  return (
    <Pressable style={[styles.timeButton, { flex: 1 }]} onPress={open}>
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={styles.timeValue}>{minutesLabel(value)}</Text>
      <Text style={styles.timeChange}>Змінити</Text>
    </Pressable>
  );
}

function Chips({ items, value, onChange }) {
  return (
    <View style={styles.chips}>
      {items.map((i) => (
        <Pressable
          key={i.key}
          style={[styles.chip, value === i.key && styles.chipActive]}
          onPress={() => onChange(i.key)}
        >
          <Text style={[styles.chipText, value === i.key && styles.chipTextActive]}>
            {i.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function SettingsScreen({ onBack }) {
  const initial = loadSettings();
  const [intervalMin, setIntervalMin] = useState(initial.intervalMin);
  const [startMin, setStartMin] = useState(initial.startMin);
  const [endMin, setEndMin] = useState(initial.endMin);
  const [summaryEnabled, setSummaryEnabled] = useState(initial.summaryEnabled);
  const [summaryMode, setSummaryMode] = useState(initial.summaryMode);
  const [summaryIntervalMin, setSummaryIntervalMin] = useState(initial.summaryIntervalMin);
  const [summaryTimes, setSummaryTimes] = useState(initial.summaryTimes);

  const updateTime = (index, value) => {
    setSummaryTimes(summaryTimes.map((t, i) => (i === index ? value : t)));
  };

  const removeTime = (index) => {
    setSummaryTimes(summaryTimes.filter((_, i) => i !== index));
  };

  const addTime = () => {
    const last = summaryTimes.length ? Math.max(...summaryTimes) : 540;
    setSummaryTimes([...summaryTimes, Math.min(last + 180, 23 * 60)]);
  };

  const save = () => {
    if (startMin >= endMin) {
      Alert.alert('Помилка', 'Початок має бути раніше, ніж кінець');
      return;
    }
    if (summaryEnabled && summaryMode === 'times' && summaryTimes.length === 0) {
      Alert.alert('Помилка', 'Додай хоча б один час для зведення');
      return;
    }
    const cleanTimes = [...new Set(summaryTimes)].sort((a, b) => a - b);
    setSetting('interval_min', intervalMin);
    setSetting('start_min', startMin);
    setSetting('end_min', endMin);
    setSetting('summary_enabled', summaryEnabled ? 1 : 0);
    setSetting('summary_mode', summaryMode);
    setSetting('summary_interval', summaryIntervalMin);
    setSetting('summary_times', cleanTimes.join(','));
    onBack(true);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.header}>Налаштування</Text>

      <Text style={styles.section}>Нагадувати кожні</Text>
      <Chips
        items={INTERVALS.map((i) => ({ key: i.min, label: i.label }))}
        value={intervalMin}
        onChange={setIntervalMin}
      />

      <Text style={styles.section}>Години нагадувань</Text>
      <TimeField label="З" value={startMin} onChange={setStartMin} />
      <TimeField label="До" value={endMin} onChange={setEndMin} />

      <View style={styles.switchRow}>
        <Text style={[styles.section, { flex: 1, marginTop: 0, marginBottom: 0 }]}>
          Зведення всіх справ
        </Text>
        <Switch value={summaryEnabled} onValueChange={setSummaryEnabled} />
      </View>

      {summaryEnabled && (
        <View>
          <Chips
            items={[
              { key: 'interval', label: 'Кожні N годин' },
              { key: 'times', label: 'У конкретний час' },
            ]}
            value={summaryMode}
            onChange={setSummaryMode}
          />

          {summaryMode === 'interval' && (
            <View>
              <Text style={styles.hint}>
                Від {minutesLabel(startMin)} до {minutesLabel(endMin)}, кожні:
              </Text>
              <Chips
                items={SUMMARY_INTERVALS.map((i) => ({ key: i.min, label: i.label }))}
                value={summaryIntervalMin}
                onChange={setSummaryIntervalMin}
              />
            </View>
          )}

          {summaryMode === 'times' && (
            <View>
              {summaryTimes.map((t, i) => (
                <View key={i} style={styles.timeRow}>
                  <TimeField label={`${i + 1}.`} value={t} onChange={(v) => updateTime(i, v)} />
                  <Pressable
                    style={styles.removeButton}
                    onPress={() => removeTime(i)}
                    accessibilityLabel="Прибрати час"
                  >
                    <Text style={styles.removeText}>✕</Text>
                  </Pressable>
                </View>
              ))}
              {summaryTimes.length < MAX_SUMMARY_TIMES && (
                <Pressable style={styles.addTimeButton} onPress={addTime}>
                  <Text style={styles.timeChange}>+ Додати час</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      )}

      <Pressable style={styles.saveButton} onPress={save}>
        <Text style={styles.addText}>Зберегти</Text>
      </Pressable>
      <Pressable style={styles.backButton} onPress={() => onBack(false)}>
        <Text style={styles.backText}>Назад без збереження</Text>
      </Pressable>

      <Pressable style={styles.testButton} onPress={sendTestNotification}>
        <Text style={styles.testText}>Тест: нагадування через 10 секунд</Text>
      </Pressable>
      <Pressable style={styles.testButton} onPress={sendTestSummary}>
        <Text style={styles.testText}>Тест: зведення через 10 секунд</Text>
      </Pressable>
      <StatusBar style="dark" />
    </ScrollView>
  );
}

export default function App() {
  const [screen, setScreen] = useState('tasks');
  const [text, setText] = useState('');
  const [deadlineMode, setDeadlineMode] = useState('none');
  const [deadline, setDeadline] = useState(null);
  const [editing, setEditing] = useState(null);
  const [lastDone, setLastDone] = useState(null);
  const [snoozeInfo, setSnoozeInfo] = useState(null);
  const [tasks, setTasks] = useState(loadTasks);
  const [settings, setSettings] = useState(loadSettings);

  const showDone = (task) => {
    if (!task) return;
    setLastDone({ id: task.id, title: task.title, summary: doneSummary(task) });
  };

  useEffect(() => {
    const handleResponse = async (response) => {
      const taskId = response?.notification.request.content.data?.taskId;
      if (!taskId) return;
      if (response.actionIdentifier === 'done') {
        showDone(await completeTask(taskId));
        setTasks(loadTasks());
      } else if (response.actionIdentifier === 'snooze') {
        const t = await snoozeTask(taskId);
        if (t) setSnoozeInfo(`«${t.title}» нагадаю через ${SNOOZE_MIN} хв`);
      }
    };

    setupNotifications().then(rescheduleAll);
    Notifications.getLastNotificationResponseAsync().then(handleResponse);
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!lastDone) return undefined;
    const timer = setTimeout(() => setLastDone(null), UNDO_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [lastDone]);

  useEffect(() => {
    if (!snoozeInfo) return undefined;
    const timer = setTimeout(() => setSnoozeInfo(null), 4000);
    return () => clearTimeout(timer);
  }, [snoozeInfo]);

  if (screen === 'settings') {
    return (
      <SettingsScreen
        onBack={(changed) => {
          setSettings(loadSettings());
          if (changed) rescheduleAll();
          setScreen('tasks');
        }}
      />
    );
  }

  const keptHours = deadline ? deadline.getHours() : 18;
  const keptMinutes = deadline ? deadline.getMinutes() : 0;

  const chooseDay = (key) => {
    if (key === 'none') {
      setDeadlineMode('none');
      setDeadline(null);
      return;
    }

    if (key === 'pick') {
      openPicker({
        value: deadline ?? new Date(),
        mode: 'date',
        minimumDate: new Date(),
        onPick: (date) => {
          const d = new Date(date);
          d.setHours(keptHours, keptMinutes, 0, 0);
          setDeadline(d);
          setDeadlineMode('pick');
        },
      });
      return;
    }

    const d = new Date();
    if (key === 'tomorrow') d.setDate(d.getDate() + 1);
    d.setHours(keptHours, keptMinutes, 0, 0);
    setDeadline(d);
    setDeadlineMode(key);
  };

  const pickTime = () => {
    openPicker({
      value: deadline,
      mode: 'time',
      onPick: (date) => {
        const d = new Date(deadline);
        d.setHours(date.getHours(), date.getMinutes(), 0, 0);
        setDeadline(d);
      },
    });
  };

  const resetForm = () => {
    setText('');
    setDeadlineMode('none');
    setDeadline(null);
    setEditing(null);
    Keyboard.dismiss();
  };

  const startEdit = (item) => {
    const d = item.deadline ? new Date(item.deadline) : null;
    setEditing({ id: item.id, originalDeadline: item.deadline });
    setText(item.title);
    setDeadline(d);
    setDeadlineMode(modeForDate(d));
  };

  const saveTask = () => {
    const title = text.trim();
    if (!title) return;

    const deadlineIso = deadline ? deadline.toISOString() : null;
    const deadlineChanged = !editing || deadlineIso !== editing.originalDeadline;
    if (deadline && deadline < new Date() && deadlineChanged) {
      Alert.alert('Цей час уже минув', 'Обери пізніший час або інший день.');
      return;
    }

    if (editing) {
      db.runSync(
        'UPDATE tasks SET title = ?, deadline = ? WHERE id = ?',
        title,
        deadlineIso,
        editing.id
      );
    } else {
      db.runSync(
        'INSERT INTO tasks (title, created_at, deadline) VALUES (?, ?, ?)',
        title,
        new Date().toISOString(),
        deadlineIso
      );
    }
    setTasks(loadTasks());
    resetForm();
    rescheduleAll();
  };

  const confirmDelete = () => {
    const id = editing.id;
    Alert.alert('Видалити завдання?', text.trim(), [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Видалити',
        style: 'destructive',
        onPress: async () => {
          await deleteTask(id);
          setTasks(loadTasks());
          resetForm();
        },
      },
    ]);
  };

  const doneTask = async (id) => {
    if (editing?.id === id) resetForm();
    showDone(await completeTask(id));
    setTasks(loadTasks());
  };

  const undoLast = async () => {
    const id = lastDone.id;
    setLastDone(null);
    await undoTask(id);
    setTasks(loadTasks());
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Мої завдання</Text>

      <Pressable onPress={() => setScreen('settings')}>
        <Text style={styles.settingsLink}>
          Нагадування: кожні {intervalLabel(settings.intervalMin)}, з {minutesLabel(settings.startMin)} до {minutesLabel(settings.endMin)}.
          {'\n'}Зведення: {summaryLabel(settings)}. Змінити
        </Text>
      </Pressable>

      {editing && <Text style={styles.editTitle}>Редагування завдання</Text>}

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="Що треба зробити?"
          value={text}
          onChangeText={setText}
          onSubmitEditing={saveTask}
        />
        <Pressable style={styles.addButton} onPress={saveTask}>
          <Text style={styles.addText}>{editing ? 'Зберегти' : 'Додати'}</Text>
        </Pressable>
      </View>

      <View style={styles.chips}>
        {DEADLINE_DAYS.map((d) => {
          const active = deadlineMode === d.key;
          const label = d.key === 'pick' && active && deadline ? formatDate(deadline) : d.label;
          return (
            <Pressable
              key={d.key}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => chooseDay(d.key)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      {deadline && (
        <Pressable style={styles.timeButton} onPress={pickTime}>
          <Text style={styles.timeLabel}>Дедлайн о</Text>
          <Text style={styles.timeValue}>{formatTime(deadline)}</Text>
          <Text style={styles.timeChange}>Змінити час</Text>
        </Pressable>
      )}

      {editing && (
        <View style={styles.editActions}>
          <Pressable style={styles.deleteButton} onPress={confirmDelete}>
            <Text style={styles.deleteText}>Видалити</Text>
          </Pressable>
          <Pressable style={styles.cancelButton} onPress={resetForm}>
            <Text style={styles.cancelText}>Скасувати</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        style={{ marginTop: 8 }}
        contentContainerStyle={{ paddingBottom: 100 }}
        data={tasks}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={<Text style={styles.empty}>Завдань немає</Text>}
        renderItem={({ item }) => {
          const info = deadlineInfo(item.deadline);
          const isEditing = editing?.id === item.id;
          return (
            <View style={[styles.task, isEditing && styles.taskEditing]}>
              <Pressable style={{ flex: 1 }} onPress={() => startEdit(item)}>
                <Text style={styles.taskText}>{item.title}</Text>
                {info && (
                  <Text style={[styles.deadline, info.overdue && styles.deadlineOverdue]}>
                    {info.text}
                  </Text>
                )}
              </Pressable>
              <Pressable style={styles.doneButton} onPress={() => doneTask(item.id)}>
                <Text style={styles.doneText}>Готово</Text>
              </Pressable>
            </View>
          );
        }}
      />

      {snoozeInfo && !lastDone && (
        <View style={styles.snackbar}>
          <Text style={[styles.snackTitle, { flex: 1, paddingVertical: 8 }]}>{snoozeInfo}</Text>
        </View>
      )}

      {lastDone && (
        <View style={styles.snackbar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.snackTitle}>Виконано: {lastDone.title}</Text>
            <Text style={styles.snackSummary}>{lastDone.summary}</Text>
          </View>
          <Pressable style={styles.undoButton} onPress={undoLast}>
            <Text style={styles.undoText}>Повернути</Text>
          </Pressable>
        </View>
      )}
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 60, paddingHorizontal: 16 },
  screen: { flex: 1, backgroundColor: '#fff' },
  scrollContent: { paddingTop: 60, paddingHorizontal: 16, paddingBottom: 40 },
  header: { fontSize: 26, fontWeight: 'bold', marginBottom: 8 },
  settingsLink: { color: '#2563eb', marginBottom: 16, lineHeight: 20 },
  editTitle: { fontSize: 14, fontWeight: 'bold', color: '#b45309', marginBottom: 8 },
  row: { flexDirection: 'row', marginBottom: 12 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
  addButton: { backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 8 },
  addText: { color: '#fff', fontWeight: 'bold' },
  task: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, borderColor: '#eee', borderRadius: 8, marginBottom: 8 },
  taskEditing: { borderColor: '#f59e0b', borderWidth: 2 },
  taskText: { fontSize: 16 },
  deadline: { fontSize: 13, color: '#b45309', marginTop: 4 },
  deadlineOverdue: { color: '#b42318', fontWeight: 'bold' },
  doneButton: { backgroundColor: '#16a34a', borderRadius: 6, paddingVertical: 6, paddingHorizontal: 12, marginLeft: 8 },
  doneText: { color: '#fff' },
  empty: { color: '#888', textAlign: 'center', marginTop: 40 },
  editActions: { flexDirection: 'row', marginBottom: 8 },
  deleteButton: { flex: 1, borderWidth: 1, borderColor: '#b42318', borderRadius: 8, padding: 12, alignItems: 'center', marginRight: 8 },
  deleteText: { color: '#b42318', fontWeight: 'bold' },
  cancelButton: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, alignItems: 'center' },
  cancelText: { color: '#333' },
  snackbar: { position: 'absolute', left: 16, right: 16, bottom: 32, flexDirection: 'row', alignItems: 'center', backgroundColor: '#16181D', borderRadius: 12, paddingVertical: 10, paddingLeft: 16, paddingRight: 8 },
  snackTitle: { color: '#fff', fontWeight: 'bold' },
  snackSummary: { color: '#C9CCD4', fontSize: 13, marginTop: 2 },
  undoButton: { paddingVertical: 10, paddingHorizontal: 12 },
  undoText: { color: '#FDBA74', fontWeight: 'bold' },
  section: { fontSize: 16, fontWeight: 'bold', marginTop: 16, marginBottom: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 24, marginBottom: 8 },
  hint: { color: '#555', marginBottom: 8 },
  timeRow: { flexDirection: 'row', alignItems: 'flex-start' },
  removeButton: { width: 48, height: 52, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  removeText: { fontSize: 18, color: '#b42318' },
  addTimeButton: { padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#2563eb', borderStyle: 'dashed', borderRadius: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2563eb', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8, marginBottom: 8 },
  chipActive: { backgroundColor: '#2563eb' },
  chipText: { color: '#2563eb' },
  chipTextActive: { color: '#fff' },
  timeButton: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, marginBottom: 8 },
  timeLabel: { fontSize: 15, color: '#555', minWidth: 40 },
  timeValue: { fontSize: 20, fontWeight: 'bold', marginLeft: 8, flex: 1 },
  timeChange: { color: '#2563eb' },
  saveButton: { backgroundColor: '#2563eb', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 24 },
  backButton: { padding: 14, alignItems: 'center' },
  backText: { color: '#666' },
  testButton: { borderWidth: 1, borderColor: '#f59e0b', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 12 },
  testText: { color: '#b45309' },
});