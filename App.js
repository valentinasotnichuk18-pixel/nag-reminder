import { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet, Text, TextInput, Pressable, View, FlatList, Keyboard, Alert,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Notifications from 'expo-notifications';

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

const INTERVALS = [
  { min: 15, label: '15 хв' },
  { min: 30, label: '30 хв' },
  { min: 60, label: '1 год' },
  { min: 120, label: '2 год' },
  { min: 180, label: '3 год' },
];

// ---------- База ----------

function getSetting(key, defaultValue) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', key);
  return row ? Number(row.value) : defaultValue;
}

function setSetting(key, value) {
  db.runSync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    key,
    String(value)
  );
}

function loadSettings() {
  return {
    intervalMin: getSetting('interval_min', 60),
    startHour: getSetting('start_hour', 8),
    endHour: getSetting('end_hour', 22),
  };
}

function loadTasks() {
  return db.getAllSync(
    "SELECT id, title FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
}

function intervalLabel(min) {
  const found = INTERVALS.find((i) => i.min === min);
  return found ? found.label : `${min} хв`;
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
  ]);
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Сповіщення вимкнені',
      'Без дозволу на сповіщення нагадування не приходитимуть. Увімкни їх у налаштуваннях телефона.'
    );
  }
}

// Час нагадувань для завдання: від часу створення кожні N хвилин у межах годин
function slotsFor(createdAtIso, s) {
  const created = new Date(createdAtIso);
  const base = created.getHours() * 60 + created.getMinutes();
  const slots = [];
  for (let m = base % s.intervalMin; m < 24 * 60; m += s.intervalMin) {
    if (m >= s.startHour * 60 && m <= s.endHour * 60) {
      slots.push({ hour: Math.floor(m / 60), minute: m % 60 });
    }
  }
  return slots;
}

async function doReschedule() {
  await Notifications.cancelAllScheduledNotificationsAsync();
  const s = loadSettings();
  const active = db.getAllSync(
    "SELECT id, title, created_at FROM tasks WHERE status = 'active'"
  );
  for (const t of active) {
    for (const slot of slotsFor(t.created_at, s)) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Нагадування',
          body: t.title,
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
}

// Черга, щоб перепланування не накладались одне на одне
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

async function completeTask(taskId) {
  db.runSync(
    "UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'active'",
    new Date().toISOString(),
    taskId
  );
  await dismissTaskNotifications(taskId);
  await rescheduleAll();
}

async function sendTestNotification() {
  const t = db.getFirstSync(
    "SELECT id, title FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
  if (!t) {
    Alert.alert('Немає завдань', 'Спочатку додай хоча б одне завдання.');
    return;
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Нагадування (тест)',
      body: t.title,
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

// ---------- Екрани ----------

function HourStepper({ label, value, onChange }) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <Pressable style={styles.stepBtn} onPress={() => onChange(Math.max(0, value - 1))}>
        <Text style={styles.stepBtnText}>-</Text>
      </Pressable>
      <Text style={styles.stepValue}>{value}:00</Text>
      <Pressable style={styles.stepBtn} onPress={() => onChange(Math.min(23, value + 1))}>
        <Text style={styles.stepBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

function SettingsScreen({ onBack }) {
  const initial = loadSettings();
  const [intervalMin, setIntervalMin] = useState(initial.intervalMin);
  const [startHour, setStartHour] = useState(initial.startHour);
  const [endHour, setEndHour] = useState(initial.endHour);

  const save = () => {
    if (startHour >= endHour) {
      Alert.alert('Помилка', 'Початок має бути раніше, ніж кінець');
      return;
    }
    setSetting('interval_min', intervalMin);
    setSetting('start_hour', startHour);
    setSetting('end_hour', endHour);
    onBack(true);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Налаштування</Text>

      <Text style={styles.section}>Нагадувати кожні</Text>
      <View style={styles.chips}>
        {INTERVALS.map((i) => (
          <Pressable
            key={i.min}
            style={[styles.chip, intervalMin === i.min && styles.chipActive]}
            onPress={() => setIntervalMin(i.min)}
          >
            <Text style={[styles.chipText, intervalMin === i.min && styles.chipTextActive]}>
              {i.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Години нагадувань</Text>
      <HourStepper label="З" value={startHour} onChange={setStartHour} />
      <HourStepper label="До" value={endHour} onChange={setEndHour} />

      <Pressable style={styles.saveButton} onPress={save}>
        <Text style={styles.addText}>Зберегти</Text>
      </Pressable>
      <Pressable style={styles.backButton} onPress={() => onBack(false)}>
        <Text style={styles.backText}>Назад без збереження</Text>
      </Pressable>

      <Pressable style={styles.testButton} onPress={sendTestNotification}>
        <Text style={styles.testText}>Тест: сповіщення через 10 секунд</Text>
      </Pressable>
      <StatusBar style="dark" />
    </View>
  );
}

export default function App() {
  const [screen, setScreen] = useState('tasks');
  const [text, setText] = useState('');
  const [tasks, setTasks] = useState(loadTasks);
  const [settings, setSettings] = useState(loadSettings);

  useEffect(() => {
    const handleResponse = async (response) => {
      if (response?.actionIdentifier === 'done') {
        const taskId = response.notification.request.content.data?.taskId;
        if (taskId) {
          await completeTask(taskId);
          setTasks(loadTasks());
        }
      }
    };

    setupNotifications().then(rescheduleAll);
    Notifications.getLastNotificationResponseAsync().then(handleResponse);
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => sub.remove();
  }, []);

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

  const addTask = () => {
    const title = text.trim();
    if (!title) return;
    db.runSync(
      'INSERT INTO tasks (title, created_at) VALUES (?, ?)',
      title,
      new Date().toISOString()
    );
    setTasks(loadTasks());
    setText('');
    Keyboard.dismiss();
    rescheduleAll();
  };

  const doneTask = async (id) => {
    await completeTask(id);
    setTasks(loadTasks());
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Мої завдання</Text>

      <Pressable onPress={() => setScreen('settings')}>
        <Text style={styles.settingsLink}>
          Нагадування: кожні {intervalLabel(settings.intervalMin)}, з {settings.startHour}:00 до {settings.endHour}:00. Змінити
        </Text>
      </Pressable>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="Що треба зробити?"
          value={text}
          onChangeText={setText}
          onSubmitEditing={addTask}
        />
        <Pressable style={styles.addButton} onPress={addTask}>
          <Text style={styles.addText}>Додати</Text>
        </Pressable>
      </View>

      <FlatList
        data={tasks}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={<Text style={styles.empty}>Завдань немає</Text>}
        renderItem={({ item }) => (
          <View style={styles.task}>
            <Text style={styles.taskText}>{item.title}</Text>
            <Pressable style={styles.doneButton} onPress={() => doneTask(item.id)}>
              <Text style={styles.doneText}>Готово</Text>
            </Pressable>
          </View>
        )}
      />
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 60, paddingHorizontal: 16 },
  header: { fontSize: 26, fontWeight: 'bold', marginBottom: 8 },
  settingsLink: { color: '#2563eb', marginBottom: 16 },
  row: { flexDirection: 'row', marginBottom: 16 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
  addButton: { backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 8 },
  addText: { color: '#fff', fontWeight: 'bold' },
  task: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, borderColor: '#eee', borderRadius: 8, marginBottom: 8 },
  taskText: { flex: 1, fontSize: 16 },
  doneButton: { backgroundColor: '#16a34a', borderRadius: 6, paddingVertical: 6, paddingHorizontal: 12 },
  doneText: { color: '#fff' },
  empty: { color: '#888', textAlign: 'center', marginTop: 40 },
  section: { fontSize: 16, fontWeight: 'bold', marginTop: 16, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2563eb', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8, marginBottom: 8 },
  chipActive: { backgroundColor: '#2563eb' },
  chipText: { color: '#2563eb' },
  chipTextActive: { color: '#fff' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  stepperLabel: { width: 40, fontSize: 16 },
  stepBtn: { width: 44, height: 44, borderRadius: 8, backgroundColor: '#e5e7eb', alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: 22 },
  stepValue: { width: 70, textAlign: 'center', fontSize: 18 },
  saveButton: { backgroundColor: '#2563eb', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 24 },
  backButton: { padding: 14, alignItems: 'center' },
  backText: { color: '#666' },
  testButton: { borderWidth: 1, borderColor: '#f59e0b', borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 32 },
  testText: { color: '#b45309' },
});